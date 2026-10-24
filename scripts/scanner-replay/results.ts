// `results.json`, as `crates/card-scanner/src/bin/replay.rs` writes it. The binary supplies
// these facts; every count and comparison drawn from them is `summary.ts`'s.

export type Score = "printing" | "card" | "wrong" | "undecided" | "error";
/**
 * What a decision settled. An ambiguous one is neither right nor wrong: its first choice scores
 * as a printing it only guessed.
 */
export type Settled = "right_printing" | "wrong_printing" | "ambiguous" | "other";
export type Card = { id: string; set: string; number: string; lang: string; name: string };
export type Got = { id: string; name: string | null; set: string | null; number: string | null };
export type FrameNow = {
  ok: boolean;
  confidence: number | null;
  distance: number | null;
  decided: string | null;
  /** Set only for a frame the session could not process: a panic or an undecodable JPEG. */
  error: string | null;
};
export type FrameThen = { ms: number; ok: boolean; decided: string | null };
/** One candidate printing of a decision and what the evidence scored it. */
export type EvidenceCandidate = {
  printing: string;
  look: number;
  /** The whole-card embedding's score. */
  whole: number;
  /** The set symbol's score; null when its gallery has no row for the printing or no crop was read. */
  symbol: number | null;
  /** The collector band's score; null likewise. */
  band: number | null;
};
/** What the evidence weighed for the last decision. */
export type Evidence = {
  candidates: EvidenceCandidate[];
  /** The printing the evidence was sure of; null left the decision ambiguous. */
  decided: string | null;
};
export type Pass = {
  name: string;
  score: Score;
  ambiguous: boolean;
  settled: Settled;
  /** How many printings the decision offered; 0 when it offered none. */
  choices: number;
  true_in_choices: boolean;
  got: Got | null;
  /** 1-based; the first decision. */
  first_decision_frame: number | null;
  /**
   * 1-based; the frame the last decision was made on. It is the scored one only when that
   * decision was still held at the end: when it was later lost the score is `undecided`.
   */
  decision_frame: number | null;
  decisions: number;
  confidence: number | null;
  distance: number | null;
  frames: FrameNow[];
  error: string | null;
  /** A pass replayed with the evidence files loaded; null otherwise. */
  evidence: Evidence | null;
};
export type Run = {
  id: string;
  received_at: string;
  card: Card;
  finish: string;
  platform: string;
  version: string;
  /** The mode the scan was sent in, as its label says: `fast` and `exact` before 2026-10-24, `neural` since. */
  mode: string;
  filtered: boolean;
  frames: number;
  known: boolean;
  then: { score: Score; got: string | null };
  /** Null when the replay is not comparable frame by frame. */
  decided_differs: number | null;
  then_frames: FrameThen[];
  passes: Pass[];
};
export type Results = {
  v: 2;
  commit: string | null;
  runs: Run[];
  skipped: { id: string; why: string }[];
};

export function parseResults(text: string): Results {
  const results = JSON.parse(text) as Results;
  if (results.v !== 2) throw new Error(`results version ${String(results.v)} is not 2`);
  return results;
}
