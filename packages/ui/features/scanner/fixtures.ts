import type {
  ScannerCandidate,
  ScannerChoice,
  ScannerLabel,
  ScannerPrefs,
  ScannerStanding,
  ScannerStatus,
  ScannerTracked,
  ScannerTrayChoice,
  ScannerTrayRow,
  ScannerVerdict,
} from "./types";

/**
 * Canned verdicts and statuses for the panels' tests and stories. One `baseVerdict` carries
 * every field a frame with a card in it shares; each named fixture below overrides only what
 * makes it that case.
 *
 * **The first fixtures keep their slug ids and the printing ones use real printing ids.** The
 * first set predates the tray and is read mostly by the developer panels; {@link VERDICTS}'
 * `resolved` and `ambiguous` and {@link TRAY_ROWS} name printings the Storybook corpus holds
 * (`packages/fake/cards.ts` — Lightning Bolt's four, Black Lotus, Urza's Saga, Ancient Tomb), so a
 * tray story draws their art rather than four placeholders.
 *
 * The shapes are `card-scanner`'s (`session.rs`, `neural_mode.rs`): a match is the embedder's
 * search, each candidate a gallery entry's pictured printing with `normalized` the cosine distance
 * halved and `distance` that × 256, the margin a 128th of a cosine; the agreement decides on two
 * frames (`decide_at`).
 */

const plains: ScannerLabel = {
  name: "Plains",
  set: "2XM",
  number: "373",
  lang: "en",
  released: "2020-08-07",
};
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
  evidence: 1.25,
  share: 0.8,
  seen: 1,
  label: plains,
  best_distance: 0.089,
};
const hierarchStanding: ScannerStanding = {
  id: "honored-hierarch-ori-17",
  evidence: 0.31,
  share: 0.2,
  seen: 1,
  label: hierarch,
  best_distance: 0.12,
};

const plainsCandidate: ScannerCandidate = {
  id: "plains-2xm-373",
  distance: 23,
  normalized: 0.089,
  label: plains,
  printings: null,
};
const hierarchCandidate: ScannerCandidate = {
  id: "honored-hierarch-ori-17",
  distance: 31,
  normalized: 0.12,
  label: hierarch,
  printings: null,
};

/** Every field an in-frame card shares; each fixture below overrides its own. */
const baseVerdict: ScannerVerdict = {
  ok: true,
  frame: { w: 1280, h: 720 },
  decode_ms: 1.9,
  read_ms: 18.4,
  matcher: true,
  quad: [
    [180, 60],
    [1100, 68],
    [1094, 660],
    [186, 652],
  ],
  candidates_examined: 1,
  match: {
    rotated: false,
    candidates: [plainsCandidate, hierarchCandidate],
    margin: 4,
  },
  tracked: null,
  decision_seq: 0,
  decision: null,
};

/** The agreement on its way: the leader's votes at five eighths of the bar. */
const votingTracked: ScannerTracked = {
  committed: false,
  confidence: 0.625,
  decide_at: 2,
  streak: 1,
  frames: 3,
  misses: 1,
  standings: [plainsStanding, hierarchStanding],
};

const voting: ScannerVerdict = { ...baseVerdict, tracked: votingTracked };

const decidedStanding: ScannerStanding = {
  id: "storm-of-saruman-ltr-72",
  evidence: 2,
  share: 1,
  seen: 2,
  label: saruman,
  best_distance: 0.043,
};

/** A decision on a picture that is one printing: `resolved`, with no choices. */
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
    finishes: ["nonfoil", "foil"],
  },
  match: {
    rotated: false,
    candidates: [
      {
        id: "storm-of-saruman-ltr-72",
        distance: 11,
        normalized: 0.043,
        label: saruman,
        printings: 1,
      },
    ],
    margin: 30,
  },
  tracked: {
    committed: true,
    confidence: 1,
    decide_at: 2,
    streak: 2,
    frames: 2,
    misses: 0,
    standings: [decidedStanding],
  },
};

/** A card in the frame the recogniser found and could not place: no match, nothing agreed. */
const noMatch: ScannerVerdict = {
  ...baseVerdict,
  match: null,
  tracked: {
    committed: false,
    confidence: 0,
    decide_at: 2,
    streak: 0,
    frames: 3,
    misses: 3,
    standings: [],
  },
};

/** A frame with no card in it — the recogniser's own `no card`. */
const noCard: ScannerVerdict = {
  ok: false,
  error: "no card",
  frame: { w: 1280, h: 720 },
  decode_ms: 1.4,
  read_ms: 16.2,
  matcher: true,
  quad: null,
  candidates_examined: 0,
  match: null,
  tracked: {
    committed: false,
    confidence: 0,
    decide_at: 2,
    streak: 0,
    frames: 0,
    misses: 3,
    standings: [],
  },
  decision_seq: 0,
  decision: null,
};

/** A frame the scanner panicked on — `session::PANIC_ERROR`, verbatim. */
const panicked: ScannerVerdict = {
  ok: false,
  error: "the scanner panicked on this frame — see the log for the assertion",
  frame: { w: 1280, h: 720 },
  decode_ms: 1.4,
  read_ms: 0,
  matcher: true,
  quad: null,
  candidates_examined: null,
  match: null,
  tracked: null,
  decision_seq: 0,
  decision: null,
};

/* ------------------------------------------------------------------------ Printings ---- */

/** The oracle ids the printing fixtures and the tray share — the Storybook corpus's own. */
const BOLT_ORACLE = "4457ed35-7c10-48c8-9776-456485fdf070";
const LOTUS_ORACLE = "5089ec1a-f881-4d55-af14-5d996171203b";
const SAGA_ORACLE = "4c6a0c30-b547-4eff-8ff4-0ca25803c076";
const TOMB_ORACLE = "23467047-6dba-4498-b783-1ebc4f74b8c2";

const lotusLea: ScannerLabel = {
  name: "Black Lotus",
  set: "lea",
  number: "232",
  lang: "en",
  released: "1993-08-05",
};
const bolt2x2: ScannerLabel = {
  name: "Lightning Bolt",
  set: "2x2",
  number: "117",
  lang: "en",
  released: "2022-07-08",
};
const boltSta: ScannerLabel = {
  name: "Lightning Bolt",
  set: "sta",
  number: "105",
  lang: "en",
  released: "2021-04-23",
};
const boltSld: ScannerLabel = {
  name: "Lightning Bolt",
  set: "sld",
  number: "1638",
  lang: "en",
  released: "2024-04-08",
};

const lotusChoice: ScannerChoice = {
  id: "b0faa7f2-b547-42c4-a810-839da50dadfe",
  oracle_id: LOTUS_ORACLE,
  label: lotusLea,
  distance: 0.062,
  finishes: ["nonfoil"],
};

/** Three printings of **one** card that one picture stands for, the named one first. */
const boltChoices: ScannerChoice[] = [
  {
    id: "f29ba16f-c8fb-42fe-aabf-87089cb214a7",
    oracle_id: BOLT_ORACLE,
    label: bolt2x2,
    distance: 0.071,
    finishes: ["nonfoil", "foil"],
  },
  {
    id: "b14fae63-2e82-49c1-8e62-d84a65f27479",
    oracle_id: BOLT_ORACLE,
    label: boltSta,
    distance: 0.071,
    finishes: ["nonfoil", "foil"],
  },
  {
    id: "4f43c378-9e6a-4ece-9c24-5dc08c977746",
    oracle_id: BOLT_ORACLE,
    label: boltSld,
    distance: 0.071,
    finishes: ["nonfoil", "foil"],
  },
];

/** The agreement count, decided on the card the standing names. */
const agreedOn = (standing: ScannerStanding): ScannerTracked => ({
  committed: true,
  confidence: 1,
  decide_at: 2,
  streak: 2,
  frames: 2,
  misses: 0,
  standings: [standing],
});

/** A decision on a picture that is one printing: `resolved`, with no choices. */
const resolved: ScannerVerdict = {
  ...baseVerdict,
  decision_seq: 1,
  decision: {
    printing: lotusChoice.id,
    oracle_id: LOTUS_ORACLE,
    label: lotusLea,
    outcome: "resolved",
    choices: [],
    replaces_previous: false,
    // Alpha was printed in one finish, so Detect needs nothing else to file it.
    finishes: ["nonfoil"],
  },
  match: {
    rotated: false,
    candidates: [
      { id: lotusChoice.id, distance: 16, normalized: 0.062, label: lotusLea, printings: null },
    ],
    margin: 31,
  },
  tracked: agreedOn({
    id: lotusChoice.id,
    evidence: 2,
    share: 1,
    seen: 2,
    label: lotusLea,
    best_distance: 0.062,
  }),
};

/**
 * A decision on a picture that stands for three printings of one card: `ambiguous`, the printings
 * it stands for as the choices — the named one first, each at the picture's own distance. This
 * decision is the only place its choice of printings is said.
 */
const ambiguous: ScannerVerdict = {
  ...baseVerdict,
  decision_seq: 2,
  decision: {
    printing: boltChoices[0].id,
    oracle_id: BOLT_ORACLE,
    label: bolt2x2,
    outcome: "ambiguous",
    choices: boltChoices,
    replaces_previous: false,
    finishes: ["nonfoil", "foil"],
  },
  match: {
    rotated: false,
    candidates: [
      { id: boltChoices[0].id, distance: 18, normalized: 0.071, label: bolt2x2, printings: 3 },
    ],
    margin: 24,
  },
  tracked: agreedOn({
    id: boltChoices[0].id,
    evidence: 2,
    share: 1,
    seen: 2,
    label: bolt2x2,
    best_distance: 0.071,
  }),
};

export const VERDICTS = { voting, decided, noMatch, noCard, panicked, resolved, ambiguous };

/**
 * Where a native build takes the Neural models from — `scanner::NEURAL_SOURCE` in
 * `crates/grimoire-core/src/scanner.rs`, verbatim. Not a place in `data/scanner/`: no file there
 * overrides them.
 */
const NEURAL_SOURCE = "crates/card-neural/models";

const scansDir = "D:\\app\\data\\scanner\\scans";

/**
 * The Neural models as a desktop or Android build carries them: compiled in, and loaded — with the
 * card names beside them. The state the reader's view draws **nothing** about.
 */
const present: ScannerStatus = {
  neural: { path: NEURAL_SOURCE, present: true, loaded: true, error: null, source: "embedded" },
  labels: 117630,
  scans_dir: scansDir,
  unapplied_filters: null,
};

/** A build with no Neural models at all — every frame fails in the crate's sentence. */
const missing: ScannerStatus = {
  neural: { path: NEURAL_SOURCE, present: false, loaded: false, error: null, source: "absent" },
  labels: 0,
  scans_dir: scansDir,
  unapplied_filters: null,
};

/** The models there and not loaded, with the load's own sentence. */
const corrupt: ScannerStatus = {
  ...present,
  neural: { ...present.neural, loaded: false, error: "gallery: bad magic" },
};

/**
 * The recogniser loaded and no card names beside it — a working scanner that answers ids, and
 * cannot be filtered.
 */
const unlabelled: ScannerStatus = { ...present, labels: 0 };

/** The web host's: the four files fetched from the app's origin, and not yet taken by a Worker. */
const store: ScannerStatus = {
  neural: { path: "/scanner-neural/", present: false, loaded: false, error: null, source: "store" },
  labels: 117630,
  scans_dir: "",
  unapplied_filters: null,
};

export const STATUS = { present, missing, corrupt, unlabelled, store };

/**
 * What `scanner_prefs` answers for a row never written — `ScannerPrefs::default()` in
 * `scanner.rs`, verbatim: no filters, the finish detected per card, an ungraded copy filed
 * at the root, developer panels hidden.
 */
export const DEFAULT_SCANNER_PREFS: ScannerPrefs = {
  filters: { sets: [], released_from: null, released_to: null, exclude_promos: false },
  finish: "detect",
  condition: "NONE",
  folderId: null,
  developer: false,
  cameraId: null,
  trayLayout: "grid",
  pointAndShoot: false,
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

/**
 * A row the scanner could not settle the finish of — Detect's `unknown`, waiting for the reader.
 * **Not a fifth row of {@link TRAY_ROWS}**, whose four shapes and their copy counts half the
 * scanner's tests and stories count on; a surface that wants the fifth shape adds this one.
 */
export const NEEDS_A_FINISH_ROW: ScannerTrayRow = {
  key: "9b2e5d71-3c84-4f0a-b6d9-1e7a4c8f2b53",
  cardId: boltChoices[1].id,
  oracleId: BOLT_ORACLE,
  name: "Lightning Bolt",
  setCode: "sta",
  collectorNumber: "105",
  finish: "unknown",
  quantity: 1,
  choices: [],
  addedAt: 1_757_901_300_000,
};
