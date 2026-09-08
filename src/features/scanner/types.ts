// TEMPORARY until Task 5 lands: `@/lib/ipc` does not export these yet, so they are declared
// here verbatim from the Task 5 brief's Interfaces block. Once Task 5 lands, replace this
// file's body with:
//   export type {
//     ScannerMethod, ScannerRule, ScannerOptions, ScannerAsset, ScannerStatus, ScannerSidecar,
//     ScannerCaptured, ScannerFrameSize, ScannerLockPhase, ScannerLock, ScannerCorner,
//     ScannerScore, ScannerTimings, ScannerCardness, ScannerTrim, ScannerStages, ScannerLabel,
//     ScannerCandidate, ScannerMatch, ScannerStanding, ScannerTracked, ScannerCollectorTry,
//     ScannerCollector, ScannerOcr, ScannerVerdict,
//   } from "@/lib/ipc";

export type ScannerMethod = "canny" | "otsu" | "both";
export type ScannerRule = "votes" | "confidence";

export interface ScannerOptions {
  work_long_edge: number;
  method: ScannerMethod;
  canny_low: number;
  canny_high: number;
  aspect_tolerance: number;
  min_cardness: number;
  stages: boolean;
  rule: ScannerRule;
  decide_at: number;
  lead_margin: number;
}

export interface ScannerAsset {
  path: string;
  present: boolean;
  loaded: boolean;
  error: string | null;
}

export interface ScannerStatus {
  bundle: ScannerAsset;
  detection_model: ScannerAsset;
  recognition_model: ScannerAsset;
  labels: number;
  scans_dir: string;
}

export interface ScannerSidecar {
  expected: string;
  reported: string;
  confidence: string;
  votes: string;
  distance: string;
}

export interface ScannerCaptured {
  saved: string;
}

export interface ScannerFrameSize {
  w: number;
  h: number;
}

export type ScannerLockPhase = "idle" | "acquiring" | "locked";

export interface ScannerLock {
  phase: ScannerLockPhase;
  agree: number;
  misses: number;
}

export type ScannerCorner = [number, number];

export interface ScannerScore {
  via: string;
  skew: number;
  aspect: number;
  area_frac: number;
  max_angle_error: number;
  total: number;
}

export interface ScannerTimings {
  resize_ms: number;
  mask_ms: number;
  contour_ms: number;
  rectify_ms: number;
  total_ms: number;
}

export interface ScannerCardness {
  title: number;
  type_line: number;
  full_width_rows: number;
  score: number;
}

export interface ScannerTrim {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ScannerStages {
  binary: string | null;
  contours: string | null;
  quad: string | null;
}

export interface ScannerLabel {
  name: string;
  set: string;
  number: string;
  lang: string;
  released: string;
}

export interface ScannerCandidate {
  id: string;
  distance: number;
  normalized: number;
  label: ScannerLabel | null;
  printings: number | null;
}

export interface ScannerMatch {
  section: string;
  rotated: boolean;
  view: number;
  views: number;
  candidates: ScannerCandidate[];
  hash_ms: number;
  margin: number | null;
  search_ms: number;
}

export interface ScannerStanding {
  id: string;
  evidence: number;
  share: number;
  seen: number;
  label: ScannerLabel | null;
  best_distance: number;
}

export interface ScannerTracked {
  committed: boolean;
  confidence: number;
  rule: ScannerRule;
  decide_at: number;
  lead: number | null;
  frozen: boolean;
  streak: number;
  frames: number;
  misses: number;
  standings: ScannerStanding[];
}

export interface ScannerCollectorTry {
  set: string;
  number: string;
  matched: string | null;
}

export interface ScannerCollector {
  raw: string;
  rotated: boolean;
  elapsed_ms: number;
  pairings: number;
  tried: ScannerCollectorTry[];
  more: number;
  band: string | null;
  matched: string | null;
}

export interface ScannerOcr {
  raw: string;
  normalized: string;
  rotated: boolean;
  elapsed_ms: number;
  band: string | null;
  matched: string | null;
  edits: number | null;
}

export interface ScannerVerdict {
  ok: boolean;
  error?: string;
  frame: ScannerFrameSize;
  decode_ms: number;
  matcher: boolean;
  lock: ScannerLock | null;
  quad: ScannerCorner[] | null;
  quad_raw: ScannerCorner[] | null;
  method: string | null;
  cardness: ScannerCardness | null;
  rejected_cardness: ScannerCardness | null;
  trim: ScannerTrim | null;
  from_lock: boolean;
  score: ScannerScore | null;
  hash: string | null;
  rectified: string | null;
  timings: ScannerTimings | null;
  candidates_examined: number | null;
  stages: ScannerStages | null;
  match: ScannerMatch | null;
  tracked: ScannerTracked | null;
  collector: ScannerCollector | null;
  ocr: ScannerOcr | null;
}
