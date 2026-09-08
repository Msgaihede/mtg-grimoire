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

export function bundleSentence(status: ScannerStatus | null): string | null {
  if (status === null || status.bundle.loaded) return null;
  return `No reference bundle. Put \`card-hashes.bin\` at ${status.bundle.path}.`;
}

export function modelsSentence(status: ScannerStatus | null): string | null {
  if (status === null || (status.detection_model.loaded && status.recognition_model.loaded)) return null;
  return `No OCR models. Put \`text-detection.rten\` and \`text-recognition.rten\` at ${status.detection_model.path}.`;
}
