import type {
  ScannerCandidate,
  ScannerChoice,
  ScannerCollector,
  ScannerDecision,
  ScannerLabel,
  ScannerOcr,
  ScannerPrefs,
  ScannerResolution,
  ScannerStanding,
  ScannerStatus,
  ScannerTier,
  ScannerTracked,
  ScannerTrayChoice,
  ScannerTrayRow,
  ScannerVerdict,
} from "./types";

/**
 * Canned verdicts and statuses for the panels' tests and stories. One `baseVerdict` carries
 * every field a frame the detector is happy with shares; each named fixture below overrides
 * only what makes it that case.
 *
 * **The Fast fixtures keep their slug ids and the Exact ones use real printing ids.** The first
 * set predates the tray and is read only by the developer panels; the Exact verdicts and
 * {@link TRAY_ROWS} name printings the Storybook corpus holds (`.storybook/fake/cards.ts` —
 * Lightning Bolt's four, Black Lotus, Urza's Saga, Ancient Tomb), so a tray story draws their art
 * rather than four placeholders.
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
  mode: "fast",
  decision_seq: 0,
  decision: null,
  resolution: null,
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

/** A Fast decision: the tracker's printing, `resolved`, and no choices — `session.rs`'s shape. */
const decided: ScannerVerdict = {
  ...baseVerdict,
  decision_seq: 1,
  decision: {
    printing: "storm-of-saruman-ltr-72",
    oracle_id: "storm-of-saruman",
    label: saruman,
    outcome: "resolved",
    choices: [],
    replaces_previous: false,
  },
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

const confidence: ScannerVerdict = {
  ...baseVerdict,
  tracked: confidenceTracked,
  // Committed, so it carries a decision like every committed frame does.
  decision_seq: 1,
  decision: {
    printing: "plains-2xm-373",
    oracle_id: "plains",
    label: plains,
    outcome: "resolved",
    choices: [],
    replaces_previous: false,
  },
};

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
  mode: "fast",
  decision_seq: 0,
  decision: null,
  resolution: null,
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
  mode: "fast",
  decision_seq: 0,
  decision: null,
  resolution: null,
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

/* ---------------------------------------------------------------------------- Exact ---- */

/** The oracle ids the Exact fixtures and the tray share — the Storybook corpus's own. */
const BOLT_ORACLE = "4457ed35-7c10-48c8-9776-456485fdf070";
const LOTUS_ORACLE = "5089ec1a-f881-4d55-af14-5d996171203b";
const SAGA_ORACLE = "4c6a0c30-b547-4eff-8ff4-0ca25803c076";
const TOMB_ORACLE = "23467047-6dba-4498-b783-1ebc4f74b8c2";

const lotusLea: ScannerLabel = { name: "Black Lotus", set: "lea", number: "232", lang: "en", released: "1993-08-05" };
const bolt2x2: ScannerLabel = { name: "Lightning Bolt", set: "2x2", number: "117", lang: "en", released: "2022-07-08" };
const boltSta: ScannerLabel = { name: "Lightning Bolt", set: "sta", number: "105", lang: "en", released: "2021-04-23" };
const boltSld: ScannerLabel = { name: "Lightning Bolt", set: "sld", number: "1638", lang: "en", released: "2024-04-08" };

const lotusChoice: ScannerChoice = {
  id: "b0faa7f2-b547-42c4-a810-839da50dadfe",
  oracle_id: LOTUS_ORACLE,
  label: lotusLea,
  distance: 0.121,
};

/** Three printings of **one** card, best first and inside the margin of each other. */
const boltChoices: ScannerChoice[] = [
  { id: "f29ba16f-c8fb-42fe-aabf-87089cb214a7", oracle_id: BOLT_ORACLE, label: bolt2x2, distance: 0.141 },
  { id: "b14fae63-2e82-49c1-8e62-d84a65f27479", oracle_id: BOLT_ORACLE, label: boltSta, distance: 0.152 },
  { id: "4f43c378-9e6a-4ece-9c24-5dc08c977746", oracle_id: BOLT_ORACLE, label: boltSld, distance: 0.163 },
];

/** Tier 0 over the whole 113 375-printing bundle — no filter set. */
const unrestricted: ScannerTier = { tier: "filters", survivors: 113375, detail: "unrestricted" };
const noClassifier = (survivors: number): ScannerTier => ({
  tier: "classifier",
  survivors,
  detail: "not implemented",
});

/** Hash, a clean title read, a collector read that pins the printing: one survivor. */
const resolvedResolution: ScannerResolution = {
  outcome: "resolved",
  choices: [lotusChoice],
  tiers: [
    unrestricted,
    { tier: "whole_card", survivors: 3, detail: "3 printings of 2 cards" },
    { tier: "title", survivors: 2, detail: 'read "black lotus" → Black Lotus (edits 0)' },
    { tier: "collector", survivors: 1, detail: "LEA 232 → Black Lotus — LEA 232" },
    { tier: "re_rank", survivors: 1, detail: "one survivor" },
    noClassifier(1),
  ],
  elapsed_ms: 1840,
};

/** A name read with no collector read, and three reprints the margin cannot split. */
const ambiguousResolution: ScannerResolution = {
  outcome: "ambiguous",
  choices: boltChoices,
  tiers: [
    unrestricted,
    { tier: "whole_card", survivors: 4, detail: "4 printings of 1 card" },
    { tier: "title", survivors: 4, detail: 'read "lightning bolt" → Lightning Bolt (edits 0)' },
    { tier: "collector", survivors: 4, detail: "no read" },
    { tier: "re_rank", survivors: 3, detail: "margin 2.8 bits" },
    noClassifier(3),
  ],
  elapsed_ms: 2210,
};

/** Nothing inside the gate and no name read — the one outcome that commits nothing. */
const notFoundResolution: ScannerResolution = {
  outcome: "not_found",
  choices: [],
  tiers: [
    unrestricted,
    { tier: "whole_card", survivors: 0, detail: "0 printings of 0 cards" },
    { tier: "title", survivors: 0, detail: "no read" },
    { tier: "collector", survivors: 0, detail: "no read" },
    { tier: "re_rank", survivors: 0, detail: "no survivors" },
    noClassifier(0),
  ],
  elapsed_ms: 1630,
};

/** A tracker frozen on a card by `commit_to` after a resolve. */
const committedOn = (standing: ScannerStanding): ScannerTracked => ({
  committed: true,
  confidence: 1,
  rule: "votes",
  decide_at: 8,
  lead: null,
  frozen: true,
  streak: 3,
  frames: 3,
  misses: 0,
  standings: [standing],
});

const exactDecision = (resolution: ScannerResolution): ScannerDecision => ({
  printing: resolution.choices[0].id,
  oracle_id: resolution.choices[0].oracle_id,
  label: resolution.choices[0].label,
  outcome: resolution.outcome,
  choices: resolution.choices,
  replaces_previous: false,
});

/** The frame an Exact resolve ran on and came to one printing. */
const exactResolved: ScannerVerdict = {
  ...baseVerdict,
  mode: "exact",
  decision_seq: 1,
  decision: exactDecision(resolvedResolution),
  resolution: resolvedResolution,
  match: {
    section: "full",
    rotated: false,
    view: 0,
    views: 4,
    candidates: [{ id: lotusChoice.id, distance: 31, normalized: 0.121, label: lotusLea, printings: 2 }],
    hash_ms: 2.2,
    margin: null,
    search_ms: 5.8,
  },
  tracked: committedOn({ id: lotusChoice.id, evidence: 16, share: 1, seen: 1, label: lotusLea, best_distance: 0.121 }),
};

/** The frame an Exact resolve ran on and came to three printings of one card. */
const exactAmbiguous: ScannerVerdict = {
  ...baseVerdict,
  mode: "exact",
  decision_seq: 2,
  decision: exactDecision(ambiguousResolution),
  resolution: ambiguousResolution,
  match: {
    section: "full",
    rotated: false,
    view: 0,
    views: 4,
    candidates: boltChoices.map((c) => ({
      id: c.id,
      distance: Math.round((c.distance ?? 0) * 256),
      normalized: c.distance ?? 0,
      label: c.label,
      printings: 4,
    })),
    hash_ms: 2.4,
    margin: 0.011,
    search_ms: 6.3,
  },
  tracked: committedOn({ id: boltChoices[0].id, evidence: 16, share: 1, seen: 1, label: bolt2x2, best_distance: 0.141 }),
};

/** The frame an Exact resolve ran on and found nothing: no decision, and `decision_seq` unmoved. */
const exactNotFound: ScannerVerdict = {
  ...baseVerdict,
  mode: "exact",
  decision_seq: 2,
  decision: null,
  resolution: notFoundResolution,
  match: null,
  tracked: {
    committed: false,
    confidence: 0,
    rule: "votes",
    decide_at: 8,
    lead: null,
    frozen: false,
    streak: 3,
    frames: 3,
    misses: 0,
    standings: [],
  },
};

export const VERDICTS = {
  voting,
  decided,
  confidence,
  noMatch,
  noCard,
  panicked,
  exactResolved,
  exactAmbiguous,
  exactNotFound,
};

/**
 * The two OCR tiers' last reads, which are **not** a field of any verdict above.
 *
 * Every verdict here has `ocr: null` and `collector: null`, and that is the ordinary frame
 * rather than an omission: the readers run on one eligible frame in four (`session::OCR_EVERY`)
 * and stop once the tracker has decided. `useScanLoop` keeps the last of each across the frames
 * that carried none, so they reach `ScannerPanels` as `lastOcr`/`lastCollector` props of their
 * own — which is what these are for.
 *
 * Deliberately a *failed* pair: the two "could not resolve" fallbacks, the pairings list and
 * its truncation line are the rows with somewhere to go wrong, and a clean read exercises none
 * of them.
 */
const ocr: ScannerOcr = {
  raw: "5torm of 5aruman!",
  normalized: "5torm of 5aruman",
  rotated: false,
  elapsed_ms: 41.2,
  band: "data:image/png;base64,iVBORw0KGgo=",
  matched: null,
  edits: null,
};

const collector: ScannerCollector = {
  raw: "0072 LTR",
  rotated: false,
  elapsed_ms: 18.6,
  pairings: 5,
  tried: [
    { set: "LTR", number: "72", matched: null },
    { set: "72", number: "LTR", matched: null },
  ],
  more: 3,
  band: "data:image/png;base64,iVBORw0KGgo=",
  matched: null,
};

export const READS = { ocr, collector };

const scannerDir = "D:\\app\\data\\scanner\\";

/** All three files placed in `data/scanner/` by hand — the state before assets shipped. */
const present: ScannerStatus = {
  bundle: { path: `${scannerDir}card-hashes.bin`, present: true, loaded: true, error: null, source: "file" },
  detection_model: {
    path: `${scannerDir}text-detection.rten`,
    present: true,
    loaded: true,
    error: null,
    source: "file",
  },
  recognition_model: {
    path: `${scannerDir}text-recognition.rten`,
    present: true,
    loaded: true,
    error: null,
    source: "file",
  },
  labels: 117630,
  scans_dir: `${scannerDir}scans`,
};

/**
 * All three out of the binary, with no file overriding them — what a release build is, and the
 * state the reader's view draws **nothing** about. The paths are still the ones a file would
 * override each from.
 */
const embedded: ScannerStatus = {
  bundle: { ...present.bundle, source: "embedded" },
  detection_model: { ...present.detection_model, source: "embedded" },
  recognition_model: { ...present.recognition_model, source: "embedded" },
  labels: 117630,
  scans_dir: `${scannerDir}scans`,
};

const missing: ScannerStatus = {
  bundle: { path: `${scannerDir}card-hashes.bin`, present: false, loaded: false, error: null, source: "absent" },
  detection_model: {
    path: `${scannerDir}text-detection.rten`,
    present: false,
    loaded: false,
    error: null,
    source: "absent",
  },
  recognition_model: {
    path: `${scannerDir}text-recognition.rten`,
    present: false,
    loaded: false,
    error: null,
    source: "absent",
  },
  labels: 0,
  scans_dir: `${scannerDir}scans`,
};

const noModels: ScannerStatus = {
  bundle: present.bundle,
  detection_model: missing.detection_model,
  recognition_model: missing.recognition_model,
  labels: 117630,
  scans_dir: `${scannerDir}scans`,
};

/**
 * Every file on disk and not one of them readable — the state `loaded` alone cannot tell from
 * `missing`, and the one that used to print an instruction to place a file that was already
 * there. Each asset carries the sentence its loader wrote.
 */
const corrupt: ScannerStatus = {
  bundle: {
    path: `${scannerDir}card-hashes.bin`,
    present: true,
    loaded: false,
    error: "bad magic: this is not a card-hashes bundle",
    source: "file",
  },
  detection_model: {
    path: `${scannerDir}text-detection.rten`,
    present: true,
    loaded: false,
    error: "could not load model: unsupported operator",
    source: "file",
  },
  recognition_model: {
    path: `${scannerDir}text-recognition.rten`,
    present: true,
    loaded: false,
    error: "could not load model: unsupported operator",
    source: "file",
  },
  labels: 0,
  scans_dir: `${scannerDir}scans`,
};

/**
 * The bundle parsed and its labels did not — `loaded: true` with an `error` beside it.
 *
 * A working scanner rather than a broken one: every match still lands, and every match reads
 * as an id. `scanner.rs` writes this for a `corpus.db` that is not there and for a read that
 * failed, which is why the panel says it *under* the verdict instead of in place of one.
 */
const unlabelled: ScannerStatus = {
  ...present,
  bundle: { ...present.bundle, error: `labels: corpus.db not found at ${scannerDir}..\\corpus.db` },
  labels: 0,
};

export const STATUS = { present, embedded, missing, noModels, corrupt, unlabelled };

/**
 * What `scanner_prefs` answers for a row never written — `ScannerPrefs::default()` in
 * `scanner.rs`, verbatim: Fast, no filters, a nonfoil ungraded copy filed at the root, developer
 * panels hidden.
 */
export const DEFAULT_SCANNER_PREFS: ScannerPrefs = {
  mode: "fast",
  filters: { sets: [], released_from: null, released_to: null },
  finish: "nonfoil",
  condition: "NONE",
  folderId: null,
  developer: false,
};

const boltTrayChoices: ScannerTrayChoice[] = boltChoices.map((c) => ({
  cardId: c.id,
  oracleId: c.oracle_id,
  name: "Lightning Bolt",
  setCode: c.label?.set ?? "",
  collectorNumber: c.label?.number ?? "",
}));

/**
 * A tray mid-session, **newest first**: a card still waiting on a printing to be picked, a
 * playset-in-progress at ×3, a foil, and the first card scanned. Four rows because those are the
 * four shapes a row takes — and the ambiguous one's `cardId` is its best choice, which is what the
 * row shows until the reader picks.
 */
export const TRAY_ROWS: ScannerTrayRow[] = [
  {
    key: "6f1d2c8e-4b7a-4e19-9c3d-2a5b8e7f1c04",
    cardId: boltChoices[0].id,
    oracleId: BOLT_ORACLE,
    name: "Lightning Bolt",
    setCode: "2x2",
    collectorNumber: "117",
    finish: "nonfoil",
    quantity: 1,
    choices: boltTrayChoices,
    addedAt: 1_757_901_240_000,
  },
  {
    key: "a3e9b7d1-58c2-4f06-b1e4-7d9c0a2f6b35",
    cardId: "c1e0f201-42cb-46a1-901a-65bb4fc18f6c",
    oracleId: SAGA_ORACLE,
    name: "Urza's Saga",
    setCode: "mh2",
    collectorNumber: "259",
    finish: "nonfoil",
    quantity: 3,
    choices: [],
    addedAt: 1_757_901_180_000,
  },
  {
    key: "0c7b4e2a-9d13-4a68-8f5e-3b6d1c9a7e20",
    cardId: "30e401e3-282b-4524-87e1-c6cd50cd6d00",
    oracleId: TOMB_ORACLE,
    name: "Ancient Tomb",
    setCode: "tmp",
    collectorNumber: "315",
    finish: "foil",
    quantity: 1,
    choices: [],
    addedAt: 1_757_901_120_000,
  },
  {
    key: "d85f1a6c-2e47-4b93-a0c8-5f1e7b3d9a62",
    cardId: lotusChoice.id,
    oracleId: LOTUS_ORACLE,
    name: "Black Lotus",
    setCode: "lea",
    collectorNumber: "232",
    finish: "nonfoil",
    quantity: 1,
    choices: [],
    addedAt: 1_757_901_060_000,
  },
];
