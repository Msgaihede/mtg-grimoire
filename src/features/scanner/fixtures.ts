import type {
  ScannerCandidate,
  ScannerLabel,
  ScannerStanding,
  ScannerStatus,
  ScannerTracked,
  ScannerVerdict,
} from "./types";

/**
 * Canned verdicts and statuses for the panels' tests and stories. One `baseVerdict` carries
 * every field a frame the detector is happy with shares; each named fixture below overrides
 * only what makes it that case.
 */

const plains: ScannerLabel = { name: "Plains", set: "2XM", number: "373", lang: "en", released: "2020-08-07" };
const hierarch: ScannerLabel = {
  name: "Honored Hierarch",
  set: "ORI",
  number: "17",
  lang: "en",
  released: "2015-07-17",
};
const saruman: ScannerLabel = {
  name: "Storm of Saruman",
  set: "LTR",
  number: "72",
  lang: "en",
  released: "2023-06-23",
};

const plainsStanding: ScannerStanding = {
  id: "plains-2xm-373",
  evidence: 5.0,
  share: 0.8,
  seen: 10,
  label: plains,
  best_distance: 0.289,
};
const hierarchStanding: ScannerStanding = {
  id: "honored-hierarch-ori-17",
  evidence: 1.25,
  share: 0.2,
  seen: 3,
  label: hierarch,
  best_distance: 0.32,
};

const plainsCandidate: ScannerCandidate = {
  id: "plains-2xm-373",
  distance: 74,
  normalized: 0.289,
  label: plains,
  printings: 132,
};
const hierarchCandidate: ScannerCandidate = {
  id: "honored-hierarch-ori-17",
  distance: 82,
  normalized: 0.32,
  label: hierarch,
  printings: 4,
};

/** The release-build timings a frame that reaches matching actually costs, measured once. */
const timings = { resize_ms: 2.1, mask_ms: 88.8, contour_ms: 5.3, rectify_ms: 47.8, total_ms: 144 };

/** Every field an in-frame, well-shaped card shares; each fixture below overrides its own. */
const baseVerdict: ScannerVerdict = {
  ok: true,
  frame: { w: 1280, h: 720 },
  decode_ms: 1.9,
  matcher: true,
  lock: { phase: "locked", agree: 3, misses: 0 },
  quad: [
    [180, 60],
    [1100, 68],
    [1094, 660],
    [186, 652],
  ],
  quad_raw: [
    [176, 58],
    [1104, 64],
    [1098, 663],
    [182, 656],
  ],
  method: "both",
  cardness: null,
  rejected_cardness: null,
  trim: null,
  from_lock: true,
  score: { via: "canny", skew: 0.4, aspect: 0.716, area_frac: 0.58, max_angle_error: 0.9, total: 0.94 },
  hash: "9f1c2a7e0b3d4f56",
  rectified: "data:image/png;base64,iVBORw0KGgo=",
  timings,
  candidates_examined: 2,
  stages: null,
  match: {
    section: "full",
    rotated: false,
    view: 0,
    views: 4,
    candidates: [plainsCandidate, hierarchCandidate],
    hash_ms: 2.3,
    margin: 0.031,
    search_ms: 6.1,
  },
  tracked: null,
  collector: null,
  ocr: null,
};

const votingTracked: ScannerTracked = {
  committed: false,
  confidence: 0.625,
  rule: "votes",
  decide_at: 8,
  lead: 4,
  frozen: false,
  streak: 5,
  frames: 12,
  misses: 1,
  standings: [plainsStanding, hierarchStanding],
};

const voting: ScannerVerdict = { ...baseVerdict, tracked: votingTracked };

const decidedStanding: ScannerStanding = {
  id: "storm-of-saruman-ltr-72",
  evidence: 8.0,
  share: 1,
  seen: 8,
  label: saruman,
  best_distance: 0.11,
};

const decided: ScannerVerdict = {
  ...baseVerdict,
  match: {
    section: "full",
    rotated: false,
    view: 0,
    views: 4,
    candidates: [{ id: "storm-of-saruman-ltr-72", distance: 30, normalized: 0.11, label: saruman, printings: 1 }],
    hash_ms: 2.1,
    margin: null,
    search_ms: 5.4,
  },
  tracked: {
    committed: true,
    confidence: 1,
    rule: "votes",
    decide_at: 8,
    lead: null,
    frozen: true,
    streak: 8,
    frames: 8,
    misses: 0,
    standings: [decidedStanding],
  },
};

const confidenceTracked: ScannerTracked = {
  committed: true,
  confidence: 0.8,
  rule: "confidence",
  decide_at: 8,
  lead: null,
  frozen: true,
  streak: 12,
  frames: 12,
  misses: 0,
  standings: [
    { ...plainsStanding, share: 0.9 },
    { ...hierarchStanding, share: 0.1 },
  ],
};

const confidence: ScannerVerdict = { ...baseVerdict, tracked: confidenceTracked };

const noMatch: ScannerVerdict = {
  ...baseVerdict,
  matcher: true,
  match: null,
  tracked: {
    committed: false,
    confidence: 0,
    rule: "votes",
    decide_at: 8,
    lead: null,
    frozen: false,
    streak: 0,
    frames: 3,
    misses: 3,
    standings: [],
  },
};

const noCard: ScannerVerdict = {
  ok: false,
  error: "no quadrilateral in this frame looks like a card (examined 365 contours)",
  frame: { w: 1280, h: 720 },
  decode_ms: 1.4,
  matcher: false,
  lock: { phase: "idle", agree: 0, misses: 3 },
  quad: null,
  quad_raw: null,
  method: null,
  cardness: null,
  rejected_cardness: null,
  trim: null,
  from_lock: false,
  score: null,
  hash: null,
  rectified: null,
  timings: null,
  candidates_examined: null,
  stages: null,
  match: null,
  tracked: null,
  collector: null,
  ocr: null,
};

const panicked: ScannerVerdict = {
  ok: false,
  error: "the detector panicked on this frame — see the log for the assertion",
  frame: { w: 1280, h: 720 },
  decode_ms: 1.4,
  matcher: false,
  lock: null,
  quad: null,
  quad_raw: null,
  method: null,
  cardness: null,
  rejected_cardness: null,
  trim: null,
  from_lock: false,
  score: null,
  hash: null,
  rectified: null,
  timings: null,
  candidates_examined: null,
  stages: null,
  match: null,
  tracked: null,
  collector: null,
  ocr: null,
};

export const VERDICTS = { voting, decided, confidence, noMatch, noCard, panicked };

const scannerDir = "D:\\app\\data\\scanner\\";

const present: ScannerStatus = {
  bundle: { path: `${scannerDir}card-hashes.bin`, present: true, loaded: true, error: null },
  detection_model: { path: `${scannerDir}text-detection.rten`, present: true, loaded: true, error: null },
  recognition_model: { path: `${scannerDir}text-recognition.rten`, present: true, loaded: true, error: null },
  labels: 117630,
  scans_dir: `${scannerDir}scans`,
};

const missing: ScannerStatus = {
  bundle: { path: `${scannerDir}card-hashes.bin`, present: false, loaded: false, error: null },
  detection_model: { path: `${scannerDir}text-detection.rten`, present: false, loaded: false, error: null },
  recognition_model: { path: `${scannerDir}text-recognition.rten`, present: false, loaded: false, error: null },
  labels: 0,
  scans_dir: `${scannerDir}scans`,
};

const noModels: ScannerStatus = {
  bundle: present.bundle,
  detection_model: { path: `${scannerDir}text-detection.rten`, present: false, loaded: false, error: null },
  recognition_model: { path: `${scannerDir}text-recognition.rten`, present: false, loaded: false, error: null },
  labels: 117630,
  scans_dir: `${scannerDir}scans`,
};

export const STATUS = { present, missing, noModels };
