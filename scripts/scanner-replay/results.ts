// `results.json`, as `crates/card-scanner/src/bin/replay.rs` writes it. The binary supplies
// these facts; every count and comparison drawn from them is `summary.ts`'s.

export type Score = "printing" | "card" | "wrong" | "undecided" | "error";
/**
 * What a decision settled. An ambiguous one is neither right nor wrong: its first choice scores
 * as a printing it only guessed.
 */
export type Settled = "right_printing" | "wrong_printing" | "ambiguous" | "other";
export type Mode = "fast" | "exact" | "neural";
export type Card = { id: string; set: string; number: string; lang: string; name: string };
export type Got = { id: string; name: string | null; set: string | null; number: string | null };
export type FrameNow = {
  ok: boolean;
  lock: string | null;
  confidence: number | null;
  distance: number | null;
  decided: string | null;
  /** Set only for a frame the session could not process: a panic, a decode, a failed resolve. */
  error: string | null;
};
export type FrameThen = { ms: number; ok: boolean; lock: string | null; decided: string | null; detail: boolean };
export type Slice = {
  frame: number;
  kind: "rectified" | "binary" | "title" | "collector";
  file: string;
  raw: string | null;
  normalized: string | null;
  matched: string | null;
  /** Collector slices: the (set, number) pairings tried, in order; else empty. */
  tried: { set: string; number: string; matched: string | null }[];
  /** Pairings tried beyond the ones listed. */
  more: number;
  /** The finish mark the scanner saw: an arbitrary JSON value as the crate serialises it. */
  mark: unknown;
  /** Title slices: edit distance from the matched name. */
  edits: number | null;
};
export type Pass = {
  name: string;
  mode: Mode;
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
  /** False when an Exact pass was too short to try to resolve at all. */
  resolve_ran: boolean;
  locked_frames: number;
  confidence: number | null;
  distance: number | null;
  frames: FrameNow[];
  tiers: { tier: string; survivors: number; detail: string }[];
  slices: Slice[];
  error: string | null;
};
export type Run = {
  id: string;
  received_at: string;
  card: Card;
  finish: string;
  platform: string;
  version: string;
  mode: Mode;
  filtered: boolean;
  detail: boolean;
  frames: number;
  known: boolean;
  then: { score: Score; got: string | null };
  /** Null when the replay is not comparable frame by frame. */
  decided_differs: number | null;
  then_frames: FrameThen[];
  passes: Pass[];
};
export type Results = {
  v: 1;
  commit: string | null;
  bundle_printings: number;
  runs: Run[];
  skipped: { id: string; why: string }[];
};

export function parseResults(text: string): Results {
  const results = JSON.parse(text) as Results;
  if (results.v !== 1) throw new Error(`results version ${String(results.v)} is not 1`);
  return results;
}
