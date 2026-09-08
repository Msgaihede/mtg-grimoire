import { RAW_CALL_UNAVAILABLE } from "@/lib/core";
import type { ScannerRule, ScannerStanding, ScannerStatus, ScannerTracked, ScannerVerdict } from "./types";

export const CARD_ASPECT = 63 / 88;
/** The distance gate, as a fraction of the descriptor's bits — `TrackerOptions::max_normalized`. */
export const SURE_DISTANCE = 0.3;

/**
 * What the page says where there is no detector to call.
 *
 * It is the browser core's own refusal rather than a second copy of the sentence: that module
 * rejects a `Uint8Array` call with this exact string, so a page that wrote its own would drift
 * from the message a reader gets if they press Scan anyway.
 */
export const WEB_SENTENCE = RAW_CALL_UNAVAILABLE;

function aspectOk(v: ScannerVerdict): boolean {
  return v.ok && v.score !== null && Math.abs(v.score.aspect - CARD_ASPECT) / CARD_ASPECT < 0.08;
}

/** The word over the video: the decided card, else what the frame is. */
export function headline(v: ScannerVerdict | null): string {
  if (v === null) return "looking…";
  const lead = v.tracked?.standings[0];
  if (v.tracked?.committed && lead?.label) return lead.label.name;
  if (!v.ok) return "no card";
  return aspectOk(v) ? "card located" : "suspect shape";
}

export function verdictWord(t: ScannerTracked | null): "decided" | "voting" | "confirmed" | "gathering" | null {
  if (t === null || t.standings.length === 0) return null;
  if (t.rule === "votes") return t.committed ? "decided" : "voting";
  return t.committed ? "confirmed" : "gathering";
}

/** 0..1. Votes over the bar under the vote rule; the two-way confidence otherwise. */
export function barFill(t: ScannerTracked | null): number {
  if (t === null) return 0;
  const lead = t.standings[0];
  if (t.rule === "votes") return lead === undefined ? 0 : Math.min(1, lead.evidence / t.decide_at);
  return Math.min(1, t.confidence);
}

export function shareLine(t: ScannerTracked | null): string {
  if (t === null) return "—";
  if (t.rule === "votes") {
    const tally = t.standings[0]?.evidence ?? 0;
    return `${tally.toFixed(1)}/${t.decide_at} · ${t.frames}f`;
  }
  return `${(t.confidence * 100).toFixed(0)}% over ${t.frames}f`;
}

export function leadLine(t: ScannerTracked | null): string {
  if (t === null || t.rule !== "votes" || t.standings.length === 0) return "—";
  return t.lead === null ? "unopposed" : `×${t.lead.toFixed(1)}`;
}

export function standingValue(s: ScannerStanding, rule: ScannerRule): string {
  return rule === "votes" ? s.evidence.toFixed(1) : `${(s.share * 100).toFixed(0)}%`;
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
 * The three file names, mirroring `src-tauri/src/scanner.rs`'s `BUNDLE_FILE`,
 * `DETECTION_MODEL` and `RECOGNITION_MODEL` — the sentences below name what a reader has to
 * put on disk, and they were three loose literals across two functions before this.
 */
const BUNDLE_FILE = "card-hashes.bin";
const DETECTION_FILE = "text-detection.rten";
const RECOGNITION_FILE = "text-recognition.rten";

/**
 * The clause every asset sentence ends with.
 *
 * **It is the only instruction that makes the rest of the sentence work.** `scanner_status`
 * loads the bundle and the models on its first call and answers out of what it loaded for the
 * rest of the session, so a file dropped into place while the app is running changes nothing a
 * reader can see — they follow the instruction, the sentence does not move, and the reasonable
 * conclusion is that the path was wrong. `ScannerPage` says the same thing about why there is
 * no `Reload assets` button; this is the half a reader actually reads.
 */
const RESTART = "Restart the app after placing or replacing a file — assets load once, at launch.";

/** A file that is *there* and did not parse. The path names it; the error says why. */
function didNotLoad(file: string, path: string, error: string): string {
  return `\`${file}\` at ${path} did not load: ${error}. ${RESTART}`;
}

/**
 * What the Match panel says instead of, or under, a card's name.
 *
 * **Three states, not two, and `loaded` alone cannot tell them apart** — which is what the
 * first draft of this got wrong. A bundle that is *absent* wants an instruction to place a
 * file. A bundle that is **present and did not parse** wants its error: telling a reader to
 * put a file where that file already is reads as the app not having looked. And a bundle that
 * loaded may still carry an `error` from the *label* load — no `corpus.db`, or a read that
 * failed — which is not a broken scanner at all: matching works and answers ids.
 */
export function bundleSentence(status: ScannerStatus | null): string | null {
  if (status === null) return null;
  const bundle = status.bundle;
  if (!bundle.present) {
    return `No reference bundle. Put \`${BUNDLE_FILE}\` at ${bundle.path}. ${RESTART}`;
  }
  if (!bundle.loaded) {
    return didNotLoad(BUNDLE_FILE, bundle.path, bundle.error ?? "no reason given");
  }
  if (bundle.error !== null) {
    return `Bundle loaded, but its names did not: ${bundle.error}. Matches will show ids. ${RESTART}`;
  }
  return null;
}

/**
 * The same three states for the reader's two `.rten` files.
 *
 * **They load as a pair and fail as one**: `TitleReader::load` writes the identical sentence
 * onto both assets, so this names whichever one is carrying it rather than printing it twice.
 * Either file missing is the placement sentence, because a lone model reads nothing.
 */
export function modelsSentence(status: ScannerStatus | null): string | null {
  if (status === null) return null;
  const det = status.detection_model;
  const rec = status.recognition_model;
  if (det.loaded && rec.loaded) return null;
  if (!det.present || !rec.present) {
    return `No OCR models. Put \`${DETECTION_FILE}\` and \`${RECOGNITION_FILE}\` at ${det.path}. ${RESTART}`;
  }
  if (det.error === null && rec.error !== null) {
    return didNotLoad(RECOGNITION_FILE, rec.path, rec.error);
  }
  return didNotLoad(DETECTION_FILE, det.path, det.error ?? "no reason given");
}
