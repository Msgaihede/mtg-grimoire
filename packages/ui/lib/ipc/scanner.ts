/**
 * The card scanner: its session, frames and verdicts, prefs and tray, and sending a scan.
 *
 * **One domain of `../ipc.ts`, split out on 2026-10-11 (issue #557).** Nothing outside
 * `packages/ui/lib/ipc*` imports this file: every page, hook, story and test goes through
 * `@/lib/ipc`, which re-exports these types and spreads `scannerCommands` into `ipc`. That is what keeps
 * `vi.mock("@/lib/ipc", …)` the one seam a suite replaces — a component that imported a wrapper
 * from here would go around every mock in the repository. ESLint refuses the import, and
 * `ipc.test.ts` reads this file with its siblings, so the struct-parity and argument-name fences
 * cover it as they covered the single file.
 */
import type { Condition } from "../conditions";
import type { Finish } from "../finish";
import type { CollectionImportItem, ImportCommitOutcome } from "./collection";
import { asciiJson, invoke } from "./invoke";

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
 * Where an asset came from — `AssetSource` in `crates/grimoire-core/src/scanner.rs`, lowercased.
 *
 * `embedded` is the copy compiled into the binary (the desktop's and Android's Neural files),
 * `absent` a build that has none, and `file` a file that was read — and, with an `error`, one
 * that was there and did not parse.
 *
 * **`store` is a host with no folder** — the web host, which fetches the Neural files from the
 * app's origin and says `store` of them, before it has fetched them included: `absent` promises a
 * path a reader could put a file at, and a page has none. So a `store` asset is never told to be
 * placed anywhere (`verdictText.ts`).
 */
export type ScannerAssetSource = "file" | "embedded" | "absent" | "store";

/** What the scanner needs, and whether it is there — `Asset` in `crates/grimoire-core/src/scanner.rs`. */
export interface ScannerAsset {
  /**
   * Where the load took it from — named even for an embedded or absent one. For a `store`
   * asset, the address the host fetches it from.
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
 * One asset, because the scanner has one thing to load — the Neural recogniser — and the card
 * names beside it, which come from the card database rather than from a file.
 */
export interface ScannerStatus {
  /**
   * The Neural scanner's built-in models — its detector, its embedder and the gallery they are
   * searched against — as one asset, because they load together or not at all. `embedded` on
   * desktop and Android, which build them in; `store` on the web, once the page has fetched them
   * from the app's origin; `absent` in a build that has none, where every frame fails. `error`
   * is the load's sentence when the files were there and did not load.
   *
   * **Built in or nothing, never placed by hand**: no file in `data/scanner/` overrides them, so
   * `path` is where a native build takes them from (`NEURAL_SOURCE`, `crates/card-neural/models`)
   * and never a place to put a file.
   */
  neural: ScannerAsset;
  /** Printings the session can name — the card database's labels. Zero answers ids alone. */
  labels: number;
  scans_dir: string;
  /**
   * **The reader's filters are not in force**, in the sentence the loaded session refused them
   * with — or `null`, which is every session that searches under what the popover shows.
   *
   * Only ever set after the session was built again — the web host ends its scanner's Worker
   * when the reader leaves the Scanner, and builds another on the next command — and the new
   * one could not take the filters the old one held: it had no card names to build the mask
   * from. The page cannot learn this from its own pushes, which went to the session that was
   * dropped. The host keeps the filters owed and offers them to the next build; an accepted
   * `scanner_set_filters` settles it too.
   */
  unapplied_filters: string | null;
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
 * **`jpeg` is the frame the scanner judged, at full resolution** (base64): the same draw of
 * the video the pump's own smaller frame was made from, kept at the camera's size up to 1920
 * pixels wide (`useScanLoop`'s `EVIDENCE_MAX_WIDTH`). Brought down to the pump's size, a run of
 * these put back through the scanner in order is what the scanner saw. The four after `ms` are
 * its answer for this frame, each `null` (or `false`) where it had none.
 */
export interface ScannerSubmissionFrame {
  jpeg: string;
  /** Milliseconds before the press this frame was taken: zero or negative. */
  ms: number;
  /** `ScannerVerdict.ok`: whether a card was found in it at all. */
  ok: boolean;
  confidence: number | null;
  /** The best candidate's distance, `ScannerCandidate.distance`. */
  distance: number | null;
  /** The printing the scanner had decided on by this frame, or `null`. */
  decided: string | null;
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
 *
 * **`cardId` and `finish` are `null` together, and only together: the reader said there is no
 * card in the last frame.** That is a scan of the scanner looking for a card where there is none
 * — a false positive's evidence, and as much worth having as a card it named wrongly. The engine
 * refuses one of the two without the other.
 */
export interface ScannerSubmission {
  /**
   * The printing in the last frame — a Scryfall id, as every `cardId` in this file is — or
   * `null` where the reader said there is no card in it.
   */
  cardId: string | null;
  /** Its finish, or `null` beside a `null` {@link ScannerSubmission.cardId}. */
  finish: Finish | null;
  /**
   * The printing the scanner had **decided** on (`ScannerDecision.printing`), or `null` while it
   * had decided nothing. Never a standing's `id`: that is the oracle id its evidence pooled on,
   * an id of another kind than {@link ScannerSubmission.cardId}.
   */
  reported: string | null;
  confidence: number | null;
  /** The best candidate's distance, `ScannerCandidate.distance`. */
  distance: number | null;
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

/**
 * One corner, in the frame's own pixels. Rust's `(f32, f32)` — a tuple, so it arrives as a
 * two-element array rather than as an `{ x, y }`.
 */
export type ScannerCorner = [number, number];

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
  /** `normalized` × 256, so a reader that reads distances as 0–256 still holds. */
  distance: number;
  /** (1 − cosine) / 2: 0 for the picture itself, 1 for its opposite. */
  normalized: number;
  /** `None` where no labels are loaded, or they do not name this id. */
  label: ScannerLabel | null;
  /** How many printings photograph alike under this look — why a look cannot name a printing alone. */
  printings: number | null;
}

/** What the card a frame voted for matched — `MatchReport` in `reference.rs`. */
export interface ScannerMatch {
  /**
   * Whether the card was read upside down. A scan that reports `rotated` every frame is a card
   * being held upside down, which is worth knowing and is invisible otherwise.
   */
  rotated: boolean;
  /** The card's best looks, best first. */
  candidates: ScannerCandidate[];
  /** The lead of the best look over the best look of another card, as a 128th of a cosine. */
  margin: number | null;
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

/** How far the agreement across frames is toward a decision — `TrackedView` in `session.rs`. */
export interface ScannerTracked {
  committed: boolean;
  /** The votes held over what deciding takes, 1 once decided. */
  confidence: number;
  /** The accepted frames a decision takes. */
  decide_at: number;
  /** The votes held. */
  streak: number;
  /** Frames read since the card was last forgotten. */
  frames: number;
  /** Frames running with no card in front of the lens. */
  misses: number;
  standings: ScannerStanding[];
}

/**
 * How a decision came out — `Outcome` in `crates/card-scanner/src/session.rs`, snake-cased by
 * serde: one printing, or a choice among printings the picture cannot tell apart.
 */
export type ScannerOutcome = "resolved" | "ambiguous";

/** One printing an ambiguous decision offers — `ChoiceView` in `session.rs`. */
export interface ScannerChoice {
  id: string;
  /** The corpus's oracle id for the printing; `null` where the corpus has none — never the
   *  printing id standing in for one. */
  oracle_id: string | null;
  label: ScannerLabel | null;
  /** As far as the look it came in by, on the 0–1 scale of {@link ScannerCandidate.normalized}. */
  distance: number | null;
  /** The finishes the printing exists in, from the corpus; empty when it did not say. */
  finishes: string[];
}

/**
 * The card the session has decided on — `DecisionView` in `session.rs`, on every committed frame.
 *
 * It is the matched picture's printing (or the first one the filters admit), and `ambiguous`
 * with those printings as the choices when the picture stands for more than one. The page adds
 * a tray row when {@link ScannerVerdict.decision_seq} moves, and reads this to build it.
 */
export interface ScannerDecision {
  printing: string;
  oracle_id: string | null;
  label: ScannerLabel | null;
  outcome: ScannerOutcome;
  /** Empty when `resolved`; the printings not ruled out, best first, when `ambiguous`. */
  choices: ScannerChoice[];
  /**
   * A second opinion on the card the previous decision named, not a second copy of it: the same
   * oracle card (or the same printing when neither has an Oracle ID), with the card in front of
   * the lens throughout — a filter change, with one card on the mat. The tray **replaces** its
   * newest row rather than adding one. `false` after the card left the frame, so a second copy
   * still adds.
   */
  replaces_previous: boolean;
  /**
   * The decided printing's finishes, from the corpus — `["nonfoil", "foil"]`, `["foil"]`,
   * `["nonfoil", "foil", "etched"]` — as Scryfall spells them. **Empty when the corpus did not
   * say**, which is not the same as a printing that exists in no finish: the page reads an empty
   * list as "no constraint", never as "nothing is possible". `reader/trayFinish.ts` is what turns
   * this into a row's finish.
   *
   * A `string[]` rather than `Finish[]` for {@link CollectionFolder.kind}'s reason: the words come
   * from Scryfall through the corpus, and a fourth finish is a word the page compares and falls
   * through on rather than a type error.
   */
  finishes: string[];
}

/**
 * What one frame came to — `Verdict` in `session.rs`, and the whole of what the page draws.
 *
 * `error` is the one optional field, because Rust's is `skip_serializing_if`: a frame that went
 * fine carries no key at all rather than a `null`.
 */
export interface ScannerVerdict {
  ok: boolean;
  error?: string;
  frame: ScannerFrameSize;
  decode_ms: number;
  /** The recogniser's read of the frame — detector, embedder and search at once. */
  read_ms: number;
  /** Whether the recogniser is loaded at all — "no models" and "no card in this frame" differ. */
  matcher: boolean;
  /** The card the frame votes for, in the frame's pixels — what an overlay draws. */
  quad: ScannerCorner[] | null;
  /** The cards the detector found and the embedder read. */
  candidates_examined: number | null;
  match: ScannerMatch | null;
  tracked: ScannerTracked | null;
  /** Moves once per new decision and never otherwise — what makes "one add per card" the
   *  session's property rather than the page's timing. */
  decision_seq: number;
  /** The decided card, on every committed frame; `null` otherwise. */
  decision: ScannerDecision | null;
}

/**
 * How the reader last left the scanner — `ScannerPrefs` in `crates/grimoire-core/src/scanner.rs`, one
 * `app_meta` row. **camelCase**, unlike every scanner struct above it: it is this app's stored
 * preference and not the detector's JSON, so it follows the rest of this file. `filters` keeps
 * the crate's snake case inside it.
 *
 * `finish`, `condition` and `folderId` are what a new tray row is born with. There is no
 * language, by decision. A row that does not parse reads as the defaults on the far side, and a
 * row written while the scanner still had modes keeps its other fields: its `mode` key is a
 * word the far side no longer reads, and passes over.
 */
export interface ScannerPrefs {
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
  /**
   * **Point and shoot**: recognition runs only for a press — a click on the desktop face, a hold
   * on the phone's — instead of from Start until Stop (`usePointAndShoot`).
   */
  pointAndShoot: boolean;
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
   * picks this printing, and what the row's finish control offers once it is adopted. Absent
   * from a tray written before the field existed.
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
  /**
   * The finishes the row's printing exists in — what its finish control offers (issue #982).
   * Empty or absent when unknown, and in a tray written before the field existed; either
   * constrains nothing.
   */
  finishes?: string[];
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

  /** `scanner::scanner_status`. Lazy: the first call loads the recogniser and the card names. */
  scannerStatus: () => invoke<ScannerStatus>("scanner_status"),
  /**
   * `scanner::scanner_frame`. **The JPEG is the whole of the call**: a frame is bytes with no
   * fields to name, so it is the body, and nothing rides beside it.
   */
  scannerFrame: (jpeg: Uint8Array) => invoke<ScannerVerdict>("scanner_frame", jpeg),
  /** `scanner::scanner_reset`. The reader pressed reset, or the next card is coming. */
  scannerReset: () => invoke<void>("scanner_reset"),
  /** `scanner::scanner_capture`. The JPEG is the body, as {@link ipc.scannerFrame}'s is, and the
   *  sidecar rides in a header. */
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
};
