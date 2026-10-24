import { HOST_SCANNER_UNAVAILABLE } from "@/lib/core/hostScanner";
import type { ScannerStanding, ScannerStatus, ScannerTracked, ScannerVerdict } from "./types";

/**
 * What a second window's Scanner view says while another window holds the scanner. The same string
 * as `scanner::OPEN_ELSEWHERE`, which is also how every command the lease refuses reads — a frame,
 * the view's heartbeat, a prefs or tray write — so the page matches on it byte for byte;
 * `ipc.test.ts` pins the Rust half.
 */
export const SCANNER_OPEN_ELSEWHERE = "The scanner is open in another window.";

/**
 * The line under {@link SCANNER_OPEN_ELSEWHERE}, on both Scanner surfaces: the gate asks again
 * each second, so the view opens by itself. It says "that window" because the engine's sentence
 * above it does.
 */
export const SCANNER_OPENS_HERE_LATER =
  "It will open here once that window closes or leaves the scanner.";

/**
 * What the engine answers when a scanner session is asked of it on a web page —
 * `scanner::NOT_IN_A_BROWSER_YET`, the same string, pinned by `ipc.test.ts`. A page's session is
 * a Worker of its own since the light app's step 7.5, and the web host answers the session's
 * commands in front of the engine, so no reader should meet this: it is the engine's backstop
 * for a call that reached it anyway.
 */
export const SCANNER_NOT_IN_A_BROWSER_YET = "The scanner does not run in a browser yet.";

/**
 * **Whether a refusal is the host saying it has no scanner to offer at all** — in its own
 * words, which this only knows the list of: the engine's sentence above, and the one a web host
 * says for a browser that cannot run the scanner's module (`@/lib/core/hostScanner`, which that
 * host imports its sentences from).
 *
 * **The page matches on them for one reason: to stay quiet.** A refused filter push is otherwise
 * an answer — the view counts its filters as settled, opens the camera and sends frames, each
 * of which would be refused in turn, as fast as the page can encode them. `useScannerPrefs`
 * reads one of these as "there is no session here" instead, so no camera is asked for and no
 * frame goes out, and `ScannerPage` draws the sentence where the picture would be.
 */
export function scannerUnavailable(sentence: string): boolean {
  return sentence === SCANNER_NOT_IN_A_BROWSER_YET || HOST_SCANNER_UNAVAILABLE.includes(sentence);
}

/**
 * `db::BUSY`, verbatim — what every write answers while a sync holds the write connection.
 * `useTray.test.ts` pins it against `db.rs`, so a reworded crate sentence goes red there rather
 * than turning every sync into a refusal the tray gives up on.
 */
export const DB_BUSY = "The card database is busy finishing a sync. Try that again in a moment.";

/**
 * **Whether a refused tray or prefs write is one that passes** — a sync holding the write
 * connection, or another window holding the scanner's lease. Neither says anything about the rows
 * or the prefs, and both end on their own, so the write is tried again until it lands. Anything
 * else — a tray row of nothing, a tray past its limit — is refused however long the page waits,
 * and gets one more try and no further: a loop there would hold the lease for good.
 */
export function refusalPasses(sentence: string): boolean {
  return sentence === DB_BUSY || sentence === SCANNER_OPEN_ELSEWHERE;
}

/**
 * The word over the video: the decided card, else what the frame is.
 *
 * **The decision's name before the agreement's leader** — the decision is what the tray adds.
 * The leader stands in only on a committed frame with no decision on it.
 */
export function headline(v: ScannerVerdict | null): string {
  if (v === null) return "looking…";
  const lead = v.tracked?.standings[0];
  const name = v.decision?.label?.name ?? lead?.label?.name;
  if (v.tracked?.committed && name) return name;
  return v.ok ? "card located" : "no card";
}

/** 0..1: the votes held over what deciding takes, 1 once decided — `TrackedView::confidence`. */
export function barFill(t: ScannerTracked | null): number {
  if (t === null) return 0;
  return Math.min(1, t.confidence);
}

/** The leader's votes over the bar, and the frames read: `1.0/2 · 3f`. */
export function shareLine(t: ScannerTracked | null): string {
  if (t === null) return "—";
  const tally = t.standings[0]?.evidence ?? 0;
  return `${tally.toFixed(1)}/${t.decide_at} · ${t.frames}f`;
}

/** One standing's votes, on the bar's scale. */
export function standingValue(s: ScannerStanding): string {
  return s.evidence.toFixed(1);
}

/** The QR scanner's three sentences, with "scan a card" in place of "scan a code". */
export function cameraSentence(err: unknown): { name: string; message: string } {
  const name = err instanceof DOMException ? err.name : err instanceof Error ? err.name : "Error";
  switch (name) {
    case "NotAllowedError":
      return { name, message: "MTG Grimoire needs camera access to scan a card." };
    case "NotFoundError":
      return { name, message: "No camera on this device." };
    default:
      return { name, message: `Camera error: ${name}.` };
  }
}

/**
 * What a reader is told of the recogniser's files — **one sentence, and only for files that
 * were there and did not load**, with the load's own reason.
 *
 * Nothing is said of files that are not there. They are never a reader's to place: built into
 * the desktop's and Android's binaries, fetched from the app's origin by a web page the first
 * time a frame is due — and until a web page has fetched them, `present` is `false` with no
 * fault in it. A build that has none fails every frame in the crate's own sentence, which the
 * page already draws where the picture is; a second sentence here would say it twice.
 */
export function neuralSentence(status: ScannerStatus | null): string | null {
  if (status === null) return null;
  const neural = status.neural;
  if (neural.loaded || neural.error === null) return null;
  return `The card recognizer did not load: ${neural.error}.`;
}
