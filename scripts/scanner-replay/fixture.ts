// Invented results for the summary's and the report's suites. No real scan is in the tree.

import type { Pass, Results, Run, Score, Slice } from "./results.ts";

const NAMES = ["As scanned", "Fast", "Exact"];

/** The card every fixture run expects; real-shaped, as Scryfall's ids are. */
export const CARD_ID = "c0c0c0c0-0000-4000-8000-000000000001";
const GOT_IDS: Record<Score, string> = {
  printing: "9e000000-0000-4000-8000-000000000001",
  card: "9e000000-0000-4000-8000-000000000002",
  wrong: "9e000000-0000-4000-8000-000000000003",
  undecided: "9e000000-0000-4000-8000-000000000004",
  error: "9e000000-0000-4000-8000-000000000005",
};
/** The id a fixture pass "matched" when it scored `score`. */
export const gotId = (score: Score) => GOT_IDS[score];

export function slice(over: Partial<Slice> & Pick<Slice, "frame" | "kind" | "file">): Slice {
  return { raw: null, normalized: null, matched: null, tried: [], more: 0, mark: null, edits: null, ...over };
}

export function pass(name: string, score: Score, over: Partial<Pass> = {}): Pass {
  const made: Pass = {
    name,
    mode: name === "Exact" ? "exact" : name === "Neural" ? "neural" : "fast",
    score,
    ambiguous: false,
    true_in_choices: false,
    got: score === "undecided" || score === "error" ? null : { id: GOT_IDS[score], name: "Shock", set: "m19", number: "156" },
    first_decision_frame: score === "undecided" || score === "error" ? null : 9,
    decision_frame: null,
    decisions: 1,
    resolve_ran: true,
    locked_frames: 5,
    confidence: 0.8,
    distance: 33,
    frames: [{ ok: true, lock: "locked", confidence: 0.8, distance: 33, decided: null, error: null }],
    tiers: [],
    slices: [],
    error: score === "error" ? "the run broke" : null,
    ...over,
  };
  // Unless a test says otherwise, the one decision is the first and the last.
  if (!("decision_frame" in over)) made.decision_frame = made.first_decision_frame;
  return made;
}

export function run(over: Partial<Run> & { scores?: [Score, Score, Score] } = {}): Run {
  const { scores = ["printing", "printing", "printing"], ...rest } = over;
  return {
    id: "20261011T101500Z-0000000000000001",
    received_at: "2026-10-11T10:15:00.000Z",
    card: { id: CARD_ID, set: "2x2", number: "117", lang: "en", name: "Lightning Bolt" },
    finish: "nonfoil",
    platform: "desktop",
    version: "0.48.0",
    mode: "fast",
    filtered: false,
    detail: false,
    frames: 12,
    known: true,
    then: { score: "printing", got: CARD_ID },
    decided_differs: 0,
    then_frames: [{ ms: 0, ok: true, lock: "locked", decided: null, detail: false }],
    passes: NAMES.map((name, i) => pass(name, scores[i])),
    ...rest,
  };
}

export function results(runs: Run[], over: Partial<Results> = {}): Results {
  return { v: 1, commit: "abc1234", bundle_printings: 113494, runs, skipped: [], ...over };
}
