/**
 * The card scanner: its session, frames and verdicts, prefs and tray, and the files it fetches on first use.
 *
 * **One domain of `../ipc.ts`, split out on 2026-10-11 (issue #557).** Nothing outside
 * `packages/ui/lib/ipc*` imports this file: every page, hook, story and test goes through
 * `@/lib/ipc`, which re-exports these types and spreads `scannerCommands` into `ipc`. That is what keeps
 * `vi.mock("@/lib/ipc", …)` the one seam a suite replaces — a component that imported a wrapper
 * from here would go around every mock in the repository. ESLint refuses the import, and
 * `ipc.test.ts` reads this file with its siblings, so the struct-parity and argument-name fences
 * cover it as they covered the single file.
 */
import { core } from "@/lib/core";
import type { Condition } from "../conditions";
import type { Finish } from "../finish";
import type { CollectionImportItem, ImportCommitOutcome } from "./collection";
import { asciiJson, invoke, type Unlisten } from "./invoke";

/**
 * Which edge detector runs — `Method` in `crates/card-scanner/src/session.rs`, whose
 * `#[serde(rename_all = "lowercase")]` is the whole of the mapping.
 */
export type ScannerMethod = "canny" | "otsu" | "both";

/**
 * How accumulated evidence becomes an answer — `CommitRule` in
 * `crates/card-scanner/src/track.rs`. Votes toward a bar, or the decayed two-way contest.
 */
export type ScannerRule = "votes" | "confidence";

/**
 * How the scanner judges a card — `ScanMode` in `session.rs`, lowercased by serde.
 *
 * `fast` is the vote rule over hash matches, with a title read only after a leaderless stretch;
 * `exact` runs the tier pipeline once per steady card and can answer with a choice of printings.
 * Switching resets the tracker, so a card half-voted in one mode is not decided in the other.
 */
export type ScanMode = "fast" | "exact";

/**
 * Which printings the scanner may answer with — `ScanFilters` in
 * `crates/card-scanner/src/filters.rs`. **Snake case**, like every scanner struct.
 *
 * Sets, a release-date range and whether promos count, and nothing else — no language, by
 * decision. An empty `sets`, two `null` dates and promos admitted is no filter at all. Dates are
 * `YYYY-MM-DD`, both ends inclusive.
 */
export interface ScanFilters {
  /** Set codes, compared case-insensitively. Empty is any set. */
  sets: string[];
  released_from: string | null;
  released_to: string | null;
  /**
   * Never answer with a printing the corpus marks a promo (Scryfall's `promo`). **Optional, and
   * absent is `false`**: the crate's struct is `#[serde(default)]`, and filters a page stored
   * before the toggle existed carry no such key.
   */
  exclude_promos?: boolean;
}

/**
 * Everything a caller can change between frames — `FrameOptions` in `session.rs`.
 *
 * Every field has a Rust-side default and the struct is `#[serde(default)]`, so a partial
 * object parses; this side sends every field regardless, because the page owns a control for
 * each and a field it omitted would silently be the crate's default rather than the reader's.
 */
export interface ScannerOptions {
  work_long_edge: number;
  method: ScannerMethod;
  canny_low: number;
  canny_high: number;
  aspect_tolerance: number;
  min_cardness: number;
  /** The binary and contour images as well as the quad. Roughly doubles the response time. */
  stages: boolean;
  /**
   * The rectified card's preview and its display hash. Nothing but the developer panels draws
   * either, so the page sets this only while the Developer switch is on.
   */
  previews: boolean;
  rule: ScannerRule;
  decide_at: number;
  lead_margin: number;
  /** Rides the same `x-scanner-options` header as the sliders — no header of its own. */
  mode: ScanMode;
}

/**
 * Where an asset came from — `AssetSource` in `crates/grimoire-core/src/scanner.rs`, lowercased.
 *
 * The load order, first hit wins: a file in `data/scanner/`, then the copy compiled into the
 * binary, then nothing. `file` also covers a file that is there and did not parse.
 *
 * **`store` is a host with no folder** — the web host, which keeps what it downloaded in the
 * browser's own storage and says `store` of all three assets, one it has not fetched yet
 * included: `absent` promises a path a reader could put a file at, and a page has none. So a
 * `store` asset is never told to be placed anywhere (`verdictText.ts`).
 */
export type ScannerAssetSource = "file" | "embedded" | "absent" | "store";

/** One file the scanner needs, and whether it is there — `Asset` in `crates/grimoire-core/src/scanner.rs`. */
export interface ScannerAsset {
  /**
   * The file the load looked at in `data/scanner/` — named even for an embedded or absent one.
   * For a `store` asset, the address the host fetches it from.
   */
  path: string;
  /** Something to load was there: the file, or for `embedded` the binary's copy. */
  present: boolean;
  loaded: boolean;
  error: string | null;
  source: ScannerAssetSource;
}

/**
 * What `scanner_status` answers — `ScannerStatus` in `crates/grimoire-core/src/scanner.rs`.
 *
 * The three assets are separate because they fail separately and the sentences differ: no
 * bundle means nothing can be named, no models mean the OCR tiers stand down and the
 * appearance match carries the frame alone.
 */
export interface ScannerStatus {
  bundle: ScannerAsset;
  detection_model: ScannerAsset;
  recognition_model: ScannerAsset;
  labels: number;
  scans_dir: string;
  /**
   * **The reader's filters are not in force**, in the sentence the loaded session refused them
   * with — or `null`, which is every session that searches under what the popover shows.
   *
   * Only ever set after the engine reloaded the session (`ScannerState::forget`, for assets
   * that arrive after the first load) and the new one could not take the filters the old one
   * held — it had no card names to build the mask from. The page cannot learn this from its own
   * pushes, which went to the session that was dropped. The engine keeps the filters owed and
   * offers them to the next reload; an accepted `scanner_set_filters` settles it too.
   */
  unapplied_filters: string | null;
}

/**
 * One of the scanner's files this install lacks — `Due` in
 * `crates/grimoire-core/src/downloads.rs`, the row every offer of a download is made of.
 *
 * **camelCase, unlike the status above**: this is the app's own answer, not the detector's JSON.
 * `bytes` is exact for a model and a measurement for the bundle, which is rebuilt weekly — so the
 * page says *about*.
 */
export interface ScannerAssetDue {
  /** `bundle`, `detectionModel` or `recognitionModel` — what {@link ScannerAssetsProgress.file} names. */
  key: string;
  /** What the reader is told it is. */
  label: string;
  bytes: number;
}

/**
 * What `scanner_assets` and `scanner_assets_fetch` answer — `Owed` in
 * `crates/grimoire-core/src/scanner_assets.rs`.
 *
 * `owed` is empty on a host whose binary carries the files (every desktop release) and on any
 * host once they have landed, and that is the page's whole rule: no rows, no offer. A host that
 * cannot fetch them at all refuses the command instead, which draws the same nothing.
 */
export interface ScannerAssetsOwed {
  owed: ScannerAssetDue[];
  /** All of `owed`, added up. */
  bytes: number;
  /** A fetch is running now — started here, or by a view that has since been left. */
  fetching: boolean;
}

/** Where a fetch of the scanner's files has got to — {@link ScannerAssetsProgress.phase}. */
export type ScannerAssetsPhase = "downloading" | "checking" | "done" | "error";

/**
 * The `scanner:assets` payload — `Progress` in `crates/grimoire-core/src/scanner_assets.rs`.
 *
 * `done` and `total` count bytes across every file the run fetches, so one bar covers the whole
 * of it. `file` is the {@link ScannerAssetDue.key} in hand, and `message` the sentence a failed
 * run ends on — the same one the command rejects with.
 */
export interface ScannerAssetsProgress {
  phase: ScannerAssetsPhase;
  file: string | null;
  done: number;
  total: number;
  message: string | null;
}

/**
 * What a captured frame is filed with — `Sidecar` in `crates/grimoire-core/src/scanner.rs`.
 *
 * Every field is a **string** rather than the number it reads as: this is a note written
 * beside a JPEG for a person grading the dataset later, and a missing figure is an empty
 * string there rather than a `null` something downstream has to render.
 */
export interface ScannerSidecar {
  expected: string;
  reported: string;
  confidence: string;
  votes: string;
  distance: string;
}

/** Where the capture landed — `Captured` in `crates/grimoire-core/src/scanner.rs`. */
export interface ScannerCaptured {
  saved: string;
}

/**
 * One frame of a sent scan: the picture the scanner was given, and what it answered for it —
 * `SubmissionFrame` in `crates/grimoire-core/src/scanner_submit.rs`.
 *
 * **`jpeg` is the pump's own frame, byte for byte** (base64) — the very bytes `scanner_frame`
 * judged, at the size and quality the pump sends — so a run of these put back through the
 * scanner in order is what the scanner saw. The five after `ms` are its answer for this frame,
 * each `null` (or `false`) where it had none.
 */
export interface ScannerSubmissionFrame {
  jpeg: string;
  /** Milliseconds before the press this frame was taken: zero or negative. */
  ms: number;
  /** `ScannerVerdict.ok`: whether a card was found in it at all. */
  ok: boolean;
  /** `ScannerLock.phase`, or `null` where the verdict carried no lock. */
  lock: ScannerLockPhase | null;
  confidence: number | null;
  /** The best candidate's distance in bits, `ScannerCandidate.distance`. */
  distance: number | null;
  /** The printing the scanner had decided on by this frame, or `null`. */
  decided: string | null;
  /** Whether a detail image went to the scanner with this frame. It is not kept or sent. */
  detail: boolean;
}

/**
 * What a reader says a scan shows, and what the scanner had said about it — `Submission` in
 * `crates/grimoire-core/src/scanner_submit.rs`.
 *
 * **A scan is a run of frames, never one picture** (`run`, oldest first — the last couple of
 * seconds the scanner saw before the press): the scanner decides over a run, so a single frame
 * cannot say what it did. The engine refuses a run too short to be one.
 *
 * **The card is an id and the finish a word, and nothing else about the card is sent from
 * here**: the engine reads the printing's name, set, number and language out of its own card
 * data, so a label can never pair one printing's id with another's name. They name **the card in
 * the last frame** — the one under the camera at the press. The figures after them are the
 * scanner's side of the story at the press, each `null` when it had none.
 */
export interface ScannerSubmission {
  /** The printing in the last frame — a Scryfall id, as every `cardId` in this file is. */
  cardId: string;
  finish: Finish;
  /**
   * The printing the scanner had **decided** on (`ScannerDecision.printing`), or `null` while it
   * had decided nothing. Never a standing's `id`: that is the oracle id its evidence pooled on,
   * an id of another kind than {@link ScannerSubmission.cardId}.
   */
  reported: string | null;
  mode: ScanMode;
  confidence: number | null;
  /** The best candidate's distance in bits, `ScannerCandidate.distance`. */
  distance: number | null;
  /** How many cards the scanner's bundle held — `ScannerStatus.labels` — or `null` unasked. */
  bundle: number | null;
  /** The sets and dates the scanner was narrowed to: they decide what it could have answered. */
  filters: ScanFilters;
  run: ScannerSubmissionFrame[];
}

/**
 * A scan the server took — `Submitted` in `scanner_submit.rs`. `id` is the reference the reader
 * is shown: nothing sent says who sent it, so it is the only way one submission is found again.
 */
export interface ScannerSubmitted {
  id: string;
}

/** The decoded frame's own size — `FrameSize` in `session.rs`. */
export interface ScannerFrameSize {
  w: number;
  h: number;
}

/** `Phase` in `crates/card-scanner/src/lock.rs`, lowercased by serde. */
export type ScannerLockPhase = "idle" | "acquiring" | "locked";

/**
 * The quad lock across frames — `LockState` in `lock.rs`.
 *
 * **Three fields and not four**: the Rust struct's `quad` is `#[serde(skip)]`, so it is not on
 * the wire at all. The smoothed quad an overlay draws is {@link ScannerVerdict.quad}.
 */
export interface ScannerLock {
  phase: ScannerLockPhase;
  /** Consecutive agreeing frames. */
  agree: number;
  misses: number;
}

/**
 * One corner, in the frame's own pixels. Rust's `(f32, f32)` — a tuple, so it arrives as a
 * two-element array rather than as an `{ x, y }`.
 */
export type ScannerCorner = [number, number];

/** How card-shaped the chosen quad is — `QuadScore` in `crates/card-scanner/src/detect.rs`. */
export interface ScannerScore {
  /** `QuadSource`: which contour route produced it. */
  via: string;
  /** How far from a parallelogram. 0 is face-on. */
  skew: number;
  aspect: number;
  area_frac: number;
  /** Worst deviation from 90° at any corner, in degrees. */
  max_angle_error: number;
  total: number;
}

/** Where the detection's time went — `DetectTimings` in `detect.rs`. */
export interface ScannerTimings {
  resize_ms: number;
  mask_ms: number;
  contour_ms: number;
  rectify_ms: number;
  total_ms: number;
}

/** How card-like the rectification is — `Cardness` in `crates/card-scanner/src/cardness.rs`. */
export interface ScannerCardness {
  title: number;
  type_line: number;
  full_width_rows: number;
  /** Combined, 0..1. Higher is more card-like. */
  score: number;
}

/**
 * Background cut off the rectification, per side, in pixels — `Margin` in
 * `crates/card-scanner/src/trim.rs`.
 */
export interface ScannerTrim {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The pipeline's intermediate images, as data URLs — `Stages` in `session.rs`. Present only
 * where {@link ScannerOptions.stages} asked for them.
 */
export interface ScannerStages {
  binary: string | null;
  contours: string | null;
  quad: string | null;
}

/** What a printing is called — `Label` in `crates/card-scanner/src/reference.rs`. */
export interface ScannerLabel {
  name: string;
  set: string;
  number: string;
  lang: string;
  released: string;
}

/** One ranked answer — `Candidate` in `reference.rs`. */
export interface ScannerCandidate {
  id: string;
  distance: number;
  /** Distance over the descriptor's width, so a threshold means the same at 128 and 256 bits. */
  normalized: number;
  /** `None` where no corpus is loaded, or the bundle names an id this corpus does not. */
  label: ScannerLabel | null;
  /** How many printings share this artwork — why an art hit cannot name a printing alone. */
  printings: number | null;
}

/** One frame's match against one section — `MatchReport` in `reference.rs`. */
export interface ScannerMatch {
  /** `Section`: which part of the card was hashed. */
  section: string;
  /**
   * Whether the 180°-rotated rectification won. A card is symmetric, so both are hashed until a
   * stretch has matched plainly one way up; after that, only the held one.
   */
  rotated: boolean;
  view: number;
  views: number;
  /** Descriptors computed — one per framing and orientation searched. What the match costs. */
  hashes: number;
  candidates: ScannerCandidate[];
  hash_ms: number;
  /** Bits between the best and second-best answer. */
  margin: number | null;
  search_ms: number;
}

/** One accumulated candidate with its label resolved — `StandingView` in `session.rs`. */
export interface ScannerStanding {
  id: string;
  evidence: number;
  share: number;
  seen: number;
  label: ScannerLabel | null;
  best_distance: number;
}

/** What the tracker has come to across the stream — `TrackedView` in `session.rs`. */
export interface ScannerTracked {
  committed: boolean;
  confidence: number;
  rule: ScannerRule;
  decide_at: number;
  lead: number | null;
  frozen: boolean;
  /** Fast decided on a run of clear frames before the tally reached `decide_at`. */
  early: boolean;
  streak: number;
  frames: number;
  misses: number;
  standings: ScannerStanding[];
}

/** One set/number pair the collector line was read as — `CollectorTry` in `session.rs`. */
export interface ScannerCollectorTry {
  set: string;
  number: string;
  matched: string | null;
}

/**
 * What a band was read from — `BandOrigin` in `ocr.rs`. The answer to "was that read at full
 * resolution?", which the crop cannot give: every band is warped to the same size.
 */
export interface ScannerBandOrigin {
  /** A camera frame (the detail frame when one came), rather than the 488×680 rectification. */
  frame: boolean;
  width: number;
  height: number;
  /** The band's own extent in that image's pixels. */
  span_width: number;
  span_height: number;
}

/**
 * What the collector line's separator says about the finish — `MarkReading` in `ocr.rs`,
 * snake-cased by serde. A foil prints a ★ between the set code and the language and a non-foil a
 * •; `unknown` is no separator found, or one that measured between the two.
 *
 * **Two finishes and never three**: the mark knows star from dot and nothing else, so no reading
 * here is ever `etched`.
 */
export type ScannerMarkReading = "foil" | "nonfoil" | "unknown";

/**
 * The separator, measured — `FinishMark` in `ocr.rs`. Every figure is `null` when no mark was
 * found at all, which is a different fact from a mark that was found and measured ambiguous.
 */
export interface ScannerFinishMark {
  reading: ScannerMarkReading;
  /** The mark's height over the line's letter height. */
  height: number | null;
  /** The mark's area over the letter height squared. */
  area: number | null;
  /** The mark's area over its convex hull's — near 1 for a dot, lower for a star's points. */
  solidity: number | null;
}

/** The collector-line tier — `CollectorView` in `session.rs`. */
export interface ScannerCollector {
  raw: string;
  rotated: boolean;
  elapsed_ms: number;
  pairings: number;
  tried: ScannerCollectorTry[];
  more: number;
  /** The crop the recogniser read, at the size it read it. */
  band: string | null;
  origin: ScannerBandOrigin | null;
  matched: string | null;
  /** The separator measured on this read's band; `null` when there was none to measure. */
  mark: ScannerFinishMark | null;
}

/** The title-band tier — `OcrView` in `session.rs`. */
export interface ScannerOcr {
  raw: string;
  /** What the name lookup actually compares: punctuation and case stripped from both sides. */
  normalized: string;
  rotated: boolean;
  elapsed_ms: number;
  band: string | null;
  matched: string | null;
  edits: number | null;
}

/**
 * How a resolve or a decision came out — `Outcome` in `crates/card-scanner/src/resolve.rs`,
 * snake-cased by serde.
 */
export type ScannerOutcome = "resolved" | "ambiguous" | "not_found";

/** One printing a resolve could be — `ChoiceView` in `resolve.rs`. */
export interface ScannerChoice {
  id: string;
  /** The corpus's oracle id for the printing; `null` where the corpus has none — never the
   *  printing id standing in for one. */
  oracle_id: string | null;
  label: ScannerLabel | null;
  /** The best normalized distance the burst reached; `null` for a printing only a name read found. */
  distance: number | null;
  /** The finishes the printing exists in, from the corpus; empty when it did not say. */
  finishes: string[];
}

/**
 * The card the session has decided on — `DecisionView` in `session.rs`, on every committed frame.
 *
 * In Fast it is the tracker's printing, `resolved`, with no choices. In Exact it is the last
 * resolve's first choice, and `ambiguous` carries the rest. The page adds a tray row when
 * {@link ScannerVerdict.decision_seq} moves, and reads this to build it.
 */
export interface ScannerDecision {
  printing: string;
  oracle_id: string | null;
  label: ScannerLabel | null;
  outcome: ScannerOutcome;
  choices: ScannerChoice[];
  /**
   * A second opinion on the card the previous decision named, not a second copy of it: the same
   * oracle card (or the same printing when neither has an Oracle ID), with the quad lock trusted
   * throughout — a switch to Exact to pin the printing, or
   * a filter change, with one card on the mat. The tray **replaces** its newest row rather than
   * adding one. `false` after the card left the frame, so a second copy still adds.
   */
  replaces_previous: boolean;
  /**
   * The decided printing's finishes, from the corpus — `["nonfoil", "foil"]`, `["foil"]`,
   * `["nonfoil", "foil", "etched"]` — as Scryfall spells them. **Empty when the corpus did not
   * say**, which is not the same as a printing that exists in no finish: the page reads an empty
   * list as "no constraint", never as "nothing is possible".
   *
   * A `string[]` rather than `Finish[]` for {@link CollectionFolder.kind}'s reason: the words come
   * from Scryfall through the corpus, and a fourth finish is a word the page compares and falls
   * through on rather than a type error.
   */
  finishes: string[];
  /** The separator reading for the decided printing, or `null` when no collector band was read
   *  for it. `reader/trayFinish.ts` is what turns this and {@link finishes} into a row's finish. */
  finish_mark: ScannerFinishMark | null;
}

/** One tier of an Exact resolve and what it left — `TierView` in `resolve.rs`. */
export interface ScannerTier {
  tier: "filters" | "whole_card" | "title" | "collector" | "re_rank" | "classifier";
  survivors: number;
  /** The tier's own words: the read name, the collector pairing, a conflict, the margin. */
  detail: string;
}

/** What an Exact resolve came to, on the frame it ran — `ResolutionView` in `resolve.rs`. */
export interface ScannerResolution {
  outcome: ScannerOutcome;
  /** Best first, at most twelve. */
  choices: ScannerChoice[];
  /** All six tiers, in order. */
  tiers: ScannerTier[];
  elapsed_ms: number;
}

/**
 * What one frame came to — `Verdict` in `session.rs`, and the whole of what the page draws.
 *
 * `error` is the one optional field, because Rust's is `skip_serializing_if`: a frame that went
 * fine carries no key at all rather than a `null`.
 */
export interface ScannerVerdict {
  /** Which mode judged this frame. */
  mode: ScanMode;
  /** Moves once per new decision and never otherwise — what makes "one add per card" the
   *  session's property rather than the page's timing. */
  decision_seq: number;
  /** The decided card, on every committed frame; `null` otherwise. */
  decision: ScannerDecision | null;
  /** Only on the frame an Exact resolve ran. */
  resolution: ScannerResolution | null;
  ok: boolean;
  error?: string;
  frame: ScannerFrameSize;
  decode_ms: number;
  /** Whether a bundle is loaded at all — "no bundle" and "no card in this frame" differ. */
  matcher: boolean;
  lock: ScannerLock | null;
  /** The lock's *smoothed* quad, which is what an overlay draws. */
  quad: ScannerCorner[] | null;
  /** This frame's own quad, for showing the jitter the smoothing removes. */
  quad_raw: ScannerCorner[] | null;
  method: string | null;
  cardness: ScannerCardness | null;
  rejected_cardness: ScannerCardness | null;
  trim: ScannerTrim | null;
  /** Whether this frame's card came from the lock's quad rather than its own. */
  from_lock: boolean;
  /**
   * Where the detector looked: `window` is the one mask that found the card, around a trusted
   * lock's quad; `full` is every method over the whole frame — every frame before a lock, a
   * window's miss, and every ninth locked frame.
   */
  search: "full" | "window";
  score: ScannerScore | null;
  /** The primary view's 256-bit dHash, for display. `null` unless the frame asked for `previews`. */
  hash: string | null;
  /** The rectified card as a data URL. `null` unless the frame asked for `previews`. */
  rectified: string | null;
  timings: ScannerTimings | null;
  candidates_examined: number | null;
  stages: ScannerStages | null;
  match: ScannerMatch | null;
  tracked: ScannerTracked | null;
  collector: ScannerCollector | null;
  ocr: ScannerOcr | null;
  /**
   * The **next** frame should carry a detail image — the same video frame at the camera's own
   * resolution, for the title and collector reads (issue #708). True only on a frame after which
   * the session expects to read; the loop latches it and pays for the full-size encode on that
   * one frame, never on every frame.
   */
  wants_detail: boolean;
  /**
   * The size of the detail image this frame's readers warped their bands from, when one was sent
   * **and used**. `null` on a frame that read nothing, and on one that read from the 960 px frame
   * because no detail came or it was not the same frame — so a panel can tell a full-resolution
   * read from a fallback one.
   */
  detail: ScannerFrameSize | null;
}

/**
 * How the reader last left the scanner — `ScannerPrefs` in `crates/grimoire-core/src/scanner.rs`, one
 * `app_meta` row. **camelCase**, unlike every scanner struct above it: it is this app's stored
 * preference and not the detector's JSON, so it follows the rest of this file. `filters` keeps
 * the crate's snake case inside it.
 *
 * `finish`, `condition` and `folderId` are what a new tray row is born with. There is no
 * language, by decision. A row that does not parse reads as the defaults on the far side.
 */
export interface ScannerPrefs {
  mode: ScanMode;
  filters: ScanFilters;
  /** A fixed finish every new row takes, or `detect` — the default — for the scanner's own read.
   *  See {@link ScannerFinishPref}. */
  finish: ScannerFinishPref;
  condition: Condition;
  /** The folder a commit files into; `null` is the collection's root. */
  folderId: number | null;
  /** Whether the developer panels are showing. */
  developer: boolean;
  /**
   * The camera the reader picked, as the webview's `deviceId`; `null` is whichever camera the
   * platform offers first. Per computer — `app_meta` does not sync — and a stored id whose camera
   * has gone opens the default without clearing the choice.
   */
  cameraId: string | null;
  /**
   * How the review tray lays out its cards. `string` on the wire, because Rust stores it verbatim;
   * read it through `trayLayoutOf`, which takes a word it does not know as the grid.
   */
  trayLayout: string;
}

/**
 * What the Defaults popover's finish can say: one of the collection's three finishes, stamped on
 * every new row as it lands, or **`detect`** — `scanner::DETECT_FINISH` — which asks the scanner.
 *
 * `detect` is a *policy* and never a finish, so it can never reach a tray row or the collection:
 * `reader/trayFinish.ts` turns it into a {@link ScannerTrayFinish} per card, and a stored row
 * written before it existed keeps the fixed finish it holds.
 */
export type ScannerFinishPref = Finish | "detect";

/**
 * A tray row's finish: one of the collection's three, or **`unknown`** — a card the scanner could
 * not read the finish of, waiting for the reader. An `unknown` row stays in the tray when the rest
 * commits; the collection never sees the word.
 */
export type ScannerTrayFinish = Finish | "unknown";

/** The review tray's two layouts — a wall of cards, or a line per card. */
export type ScannerTrayLayout = "grid" | "list";

/** One printing a tray row could be — `ScannerTrayChoice` in `scanner.rs`. */
export interface ScannerTrayChoice {
  cardId: string;
  oracleId: string | null;
  name: string;
  setCode: string;
  collectorNumber: string;
  /**
   * The finishes the printing exists in — what settles an Unknown row's finish when the reader
   * picks this printing. Absent from a printing picked through *More printings…*, whose dialog
   * does not carry them, and from a tray written before the field existed.
   */
  finishes?: string[];
}

/**
 * One card waiting in the review tray — `ScannerTrayRow` in `scanner.rs`, stored whole in one
 * `app_meta` row and handed back as the page wrote it.
 *
 * `key` is the page's own stable id for the row. `choices` is non-empty only while the row is
 * still a choice to make. `addedAt` is the page's clock, in milliseconds. The write refuses a
 * `quantity` below one and a tray longer than 5,000 rows, in words. `finish` may be `unknown`
 * ({@link ScannerTrayFinish}); the store keeps it as a string and checks nothing about it.
 */
export interface ScannerTrayRow {
  key: string;
  cardId: string;
  oracleId: string | null;
  name: string;
  setCode: string;
  collectorNumber: string;
  finish: ScannerTrayFinish;
  quantity: number;
  choices: ScannerTrayChoice[];
  addedAt: number;
}

/** The scanner commands — spread into `ipc` by `../ipc.ts`, which is the only reader of this object. */
export const scannerCommands = {
  /**
   * `scanner::scanner_elsewhere` — whether another window holds the scanner's lease. Takes
   * nothing; only the session commands take it.
   */
  scannerElsewhere: () => invoke<boolean>("scanner_elsewhere"),
  /**
   * `scanner::scanner_hold` — take or renew this window's scanner lease, and nothing else. The
   * mounted Scanner view's heartbeat, sent on mount and every `SCANNER_ELSEWHERE_POLL_MS` while it
   * stays, so the view holds the scanner whatever its camera is doing. Refuses with
   * `SCANNER_OPEN_ELSEWHERE` when another window holds it.
   */
  scannerHold: () => invoke<void>("scanner_hold"),

  /** `scanner::scanner_status`. Lazy: the first call loads the bundle and the models. */
  scannerStatus: () => invoke<ScannerStatus>("scanner_status"),
  /**
   * `scanner::scanner_frame`. The JPEG is the body and the options ride in a header, because a
   * frame is bytes with no fields to name.
   *
   * **A `detail` image rides in the same body, behind the frame**, and `x-scanner-detail` is the
   * frame's byte length — the one fact the far end needs to split the two. It is the same video
   * frame at full resolution, which the crate warps the title and collector bands out of, so the
   * pair has to arrive in one request: two would let a second frame's pixels stand in for the
   * first's quad. With no detail (or an empty one) the call is byte for byte what it was before
   * the detail existed — no second header, no copy — because the far end refuses an empty detail
   * in words and every frame but the one before a read carries none.
   */
  scannerFrame: (jpeg: Uint8Array, options: ScannerOptions, detail?: Uint8Array | null) => {
    const optionsHeader = asciiJson(options);
    if (detail == null || detail.length === 0) {
      return invoke<ScannerVerdict>("scanner_frame", jpeg, {
        headers: { "x-scanner-options": optionsHeader },
      });
    }
    const body = new Uint8Array(jpeg.length + detail.length);
    body.set(jpeg, 0);
    body.set(detail, jpeg.length);
    return invoke<ScannerVerdict>("scanner_frame", body, {
      headers: { "x-scanner-options": optionsHeader, "x-scanner-detail": String(jpeg.length) },
    });
  },
  /** `scanner::scanner_reset`. The reader pressed reset, or the next card is coming. */
  scannerReset: () => invoke<void>("scanner_reset"),
  /** `scanner::scanner_capture`. The same shape as {@link ipc.scannerFrame}: the JPEG is the
   *  body and the sidecar rides in a header. */
  scannerCapture: (jpeg: Uint8Array, sidecar: ScannerSidecar) =>
    invoke<ScannerCaptured>("scanner_capture", jpeg, {
      headers: { "x-scanner-capture": asciiJson(sidecar) },
    }),
  /**
   * `scanner_submit::submit`, as `scanner_submit`. **The one command that sends camera pictures
   * off the device**: the run of frames in `submission` and the card a reader says they show go
   * to the scan inbox (`infrastructure/scan-worker/`), where they are kept to improve the
   * scanner. **Only ever called from a reader's press on Send**, with those pictures on the
   * screen.
   *
   * The frames are base64 in the arguments and not a raw body like {@link ipc.scannerFrame}'s:
   * this is one call a press, it has to be awaited across a network, and the page already holds
   * the text to draw the pictures with. Rejects in one sentence — a run too short to be one, no
   * such printing, a finish that printing does not come in, an inbox that is full or cannot be
   * reached.
   */
  scannerSubmit: (submission: ScannerSubmission) =>
    invoke<ScannerSubmitted>("scanner_submit", { submission }),
  /**
   * `scanner::scanner_set_filters`. Narrows every later frame to these sets and dates, and resets
   * the tracker. **Rejects in the crate's words** — no card names loaded to filter by, or filters
   * no printing matches — and a rejection leaves the previous filters in force.
   */
  scannerSetFilters: (filters: ScanFilters) => invoke<void>("scanner_set_filters", { filters }),
  /** `scanner::scanner_prefs`. Never rejects: a missing or unreadable row is the defaults. */
  scannerPrefs: () => invoke<ScannerPrefs>("scanner_prefs"),
  /** `scanner::set_scanner_prefs`. Written whole; rejects only with the write lock's `BUSY`. */
  setScannerPrefs: (prefs: ScannerPrefs) => invoke<void>("set_scanner_prefs", { prefs }),
  /** `scanner::scanner_tray`. Never rejects: a missing or unreadable row is an empty tray. */
  scannerTray: () => invoke<ScannerTrayRow[]>("scanner_tray"),
  /**
   * `scanner::set_scanner_tray`. Written whole. Rejects a row with fewer than one copy and a tray
   * longer than 5,000 rows, in words, and leaves the stored tray as it was.
   */
  setScannerTray: (rows: ScannerTrayRow[]) => invoke<void>("set_scanner_tray", { rows }),
  /**
   * `scanner::scanner_tray_commit`. The tray's rows into the collection (`add` mode, into
   * `folderId` or the root) **and** `remaining` stored as the tray, in one transaction — so no
   * restart can bring back a row the collection already holds. Refuses as
   * {@link ipc.collectionImportCommit} and {@link ipc.setScannerTray} do, and a refusal from either
   * half leaves the collection and the stored tray both as they were.
   */
  scannerTrayCommit: (
    items: CollectionImportItem[],
    folderId: number | null,
    remaining: ScannerTrayRow[],
  ) => invoke<ImportCommitOutcome>("scanner_tray_commit", { items, folderId, remaining }),
  /**
   * `scanner::scanner_tray_archive`. The tray's rows **into the scan history and nowhere else**
   * and `remaining` stored as the tray, in one write — the trade page's Archive, for a pile the
   * reader wants a record of and does not own. Answers the batch's id, or `null` when `items` was
   * empty and nothing was kept. Refuses as {@link ipc.setScannerTray} does, and for a line naming
   * a printing the card database lacks or no finish; a refusal leaves the history and the stored
   * tray both as they were.
   */
  scannerTrayArchive: (items: CollectionImportItem[], remaining: ScannerTrayRow[]) =>
    invoke<number | null>("scanner_tray_archive", { items, remaining }),
  /**
   * `scanner_assets::owed`, as `scanner_assets`. Which of the scanner's three files this install
   * lacks, and what fetching them costs. **Empty where the binary carries them** — a desktop
   * release build — and rejected on a host that cannot fetch them, so a page draws its offer
   * from the answer and never from what kind of host it is on.
   */
  scannerAssets: () => invoke<ScannerAssetsOwed>("scanner_assets"),
  /**
   * `scanner_assets::fetch`, as `scanner_assets_fetch`. Downloads every owed file, checks each
   * before it is kept, and lets the engine's session go so the next scanner command reads them —
   * no restart. Answers what is owed afterwards (nothing, when it worked); rejects with one
   * sentence, and with `ALREADY_FETCHING`'s while another call is running. **Only ever called
   * from a reader's press.** Progress arrives through {@link ipc.onScannerAssets}.
   */
  scannerAssetsFetch: () => invoke<ScannerAssetsOwed>("scanner_assets_fetch"),
  /** The fetch's progress — `scanner_assets::PROGRESS_EVENT`. Best effort, like every event:
   *  the command's own answer is what says a fetch ended. */
  onScannerAssets: (cb: (e: ScannerAssetsProgress) => void): Unlisten =>
    core.listen<ScannerAssetsProgress>("scanner:assets", cb),
};
