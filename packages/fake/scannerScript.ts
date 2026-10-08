/**
 * What the fake's camera "sees": a short pile of cards, laid down one at a time.
 *
 * **Until step 7.6 `scanner_frame` answered the decided fixture on every frame**, with a
 * `decision_seq` that never moved — and `useScanLoop` takes the first number it sees as a baseline,
 * so over the fake a live camera never added a card. Nothing could drive the reader's half of the
 * Scanner without the real engine: not a story with a camera, not `mobile:dev`, not a smoke. This
 * is the script that replaced it — a believable session a frame at a time, so the page, its
 * stories and `scripts/phone-scanner-smoke.mjs` have cards landing in the tray.
 *
 * **One card is thirteen frames**: nothing in frame, the tracker weighing it, the frame that
 * decides (the one that moves `decision_seq`), and the card lying there decided until it is lifted.
 * The decided card rides every held frame with the *same* number, as the session's does — which is
 * what makes "one add per card" a property the page has to honour rather than one the fake hands
 * it. After the last card the camera looks at an empty desk; `scanner_reset` lays the pile down
 * again, and the number it has reached survives that, as the crate's does.
 *
 * **The pile is the tray's four shapes, in the Storybook corpus's own printings** (so every row
 * draws its art): a card, the same card again (a bump to ×2), one whose finish the collector line
 * did not settle (`Unknown`, for the reader), a printing sold one way, and Lightning Bolt — which
 * Fast names outright and Exact cannot tell from two reprints, so the row waits on a pick.
 *
 * **What it does not do**: it never asks for a detail frame (`wants_detail` stays `false`), it
 * reads no title and no collector line, it ignores the filters, and the quad it reports is the
 * fixture's whatever the camera shows. Those are the engine's to prove.
 */
import { MARKS, VERDICTS } from "@/features/scanner/fixtures";
import type {
  ScanMode,
  ScannerChoice,
  ScannerDecision,
  ScannerFinishMark,
  ScannerLabel,
  ScannerResolution,
  ScannerStanding,
  ScannerVerdict,
} from "@/lib/ipc";
import { CARDS } from "./cards";

/**
 * How long one fake frame takes to answer. The real round trip is about 110–200 ms (a release
 * build, `card-scanner.md` §9 *Measured in the app*); answered at once, a browser's pump would
 * send sixty frames a second and lay the whole pile down in under a second.
 */
export const FAKE_FRAME_MS = 110;

/** Frames with nothing in frame before a card is laid down. */
const LOOKING = 3;
/** Frames the tracker spends weighing it. */
const WEIGHING = 4;
/** Frames the decided card lies there before it is lifted — more than `DECISION_GAP_FRAMES`. */
const HELD = 5;
/** One card, start to finish: the three stretches and the one frame that decides. */
export const FRAMES_PER_CARD = LOOKING + WEIGHING + 1 + HELD;

const SAGA = "c1e0f201-42cb-46a1-901a-65bb4fc18f6c";
const TOMB = "30e401e3-282b-4524-87e1-c6cd50cd6d00";
const LOTUS = "b0faa7f2-b547-42c4-a810-839da50dadfe";
const BOLT_2X2 = "f29ba16f-c8fb-42fe-aabf-87089cb214a7";
const BOLT_STA = "b14fae63-2e82-49c1-8e62-d84a65f27479";
const BOLT_SLD = "4f43c378-9e6a-4ece-9c24-5dc08c977746";

interface PileCard {
  /** The printing Fast names, and Exact's first choice. */
  id: string;
  /** The reprints Exact's resolve cannot split from it — none for a card it pins. */
  rivals: readonly string[];
  /** The collector line's separator as it measured, or `null` for a card with no such line. */
  mark: ScannerFinishMark | null;
}

/** The cards on the desk, in the order they are laid down. */
export const FAKE_PILE: readonly PileCard[] = [
  { id: SAGA, rivals: [], mark: MARKS.dot },
  { id: SAGA, rivals: [], mark: MARKS.dot },
  { id: TOMB, rivals: [], mark: MARKS.unmeasured },
  { id: LOTUS, rivals: [], mark: null },
  { id: BOLT_2X2, rivals: [BOLT_STA, BOLT_SLD], mark: MARKS.unmeasured },
];

/** Where a session has got to. One per fake database, so two stories never share a pile. */
export interface ScanScript {
  /** Frames answered since the pile was laid down. */
  frame: number;
  /** `decision_seq`: moved once per decided card, and never by a reset. */
  seq: number;
}

export function newScanScript(): ScanScript {
  return { frame: 0, seq: 0 };
}

/** `scanner_reset`: the pile again from its first card. The number stays where it got to. */
export function resetScanScript(script: ScanScript): void {
  script.frame = 0;
}

function corpusCard(id: string) {
  const card = CARDS.find((c) => c.id === id);
  if (card === undefined) throw new Error(`the fake scanner's pile names a printing the corpus lost: ${id}`);
  return card;
}

function labelOf(id: string): ScannerLabel {
  const card = corpusCard(id);
  return {
    name: card.name,
    set: card.setCode,
    number: card.collectorNumber,
    lang: card.lang,
    released: card.releasedAt ?? "",
  };
}

function finishesOf(id: string): string[] {
  return JSON.parse(corpusCard(id).finishes ?? "[]") as string[];
}

function choiceOf(id: string, distance: number): ScannerChoice {
  return {
    id,
    oracle_id: corpusCard(id).oracleId,
    label: labelOf(id),
    distance,
    finishes: finishesOf(id),
  };
}

function standingOf(id: string, evidence: number, seen: number): ScannerStanding {
  return { id, evidence, share: 1, seen, label: labelOf(id), best_distance: 0.11 };
}

/** A verdict as the frame asked for it: the mode echoed, and no previews unless they were asked for. */
function framed(verdict: ScannerVerdict, mode: ScanMode, previews: boolean, seq: number): ScannerVerdict {
  return {
    ...verdict,
    mode,
    decision_seq: seq,
    rectified: previews ? verdict.rectified : null,
    hash: previews ? verdict.hash : null,
  };
}

/** A card in frame, locked, the tracker `n` frames into weighing it. */
function weighing(card: PileCard, n: number): ScannerVerdict {
  const base = VERDICTS.voting;
  return {
    ...base,
    match: base.match && {
      ...base.match,
      candidates: [{ id: card.id, distance: 30, normalized: 0.11, label: labelOf(card.id), printings: 1 }],
      margin: null,
    },
    tracked: base.tracked && {
      ...base.tracked,
      confidence: n / (WEIGHING + 1),
      lead: null,
      streak: n,
      frames: n,
      misses: 0,
      // Short of the bar's eight on the last weighing frame, so the bar is never full before
      // the frame that decides.
      standings: [standingOf(card.id, n * 1.75, n)],
    },
  };
}

/** The resolve Exact reports on the frame that decides: one printing, or the ones it cannot split. */
function resolutionOf(card: PileCard): ScannerResolution {
  const choices = [card.id, ...card.rivals].map((id, i) => choiceOf(id, 0.121 + i * 0.011));
  const like = card.rivals.length > 0 ? VERDICTS.exactAmbiguous : VERDICTS.exactResolved;
  return {
    outcome: card.rivals.length > 0 ? "ambiguous" : "resolved",
    choices,
    // The fixture's own tier table: the developer's view of a resolve, which no reader's surface
    // draws, so the figures in it are not this card's and are not claimed to be.
    tiers: like.resolution?.tiers ?? [],
    elapsed_ms: like.resolution?.elapsed_ms ?? 0,
  };
}

function decisionOf(card: PileCard, mode: ScanMode): ScannerDecision {
  const ambiguous = mode === "exact" && card.rivals.length > 0;
  return {
    printing: card.id,
    oracle_id: corpusCard(card.id).oracleId,
    label: labelOf(card.id),
    outcome: ambiguous ? "ambiguous" : "resolved",
    choices: mode === "exact" ? resolutionOf(card).choices : [],
    replaces_previous: false,
    finishes: finishesOf(card.id),
    finish_mark: card.mark,
  };
}

/** The card decided: on the deciding frame (with Exact's resolve) and on every held one after. */
function decided(card: PileCard, mode: ScanMode, deciding: boolean): ScannerVerdict {
  const base = VERDICTS.decided;
  return {
    ...base,
    decision: decisionOf(card, mode),
    // A resolve is reported on the one frame it ran on.
    resolution: mode === "exact" && deciding ? resolutionOf(card) : null,
    match: base.match && {
      ...base.match,
      candidates: [{ id: card.id, distance: 30, normalized: 0.11, label: labelOf(card.id), printings: 1 }],
    },
    tracked: base.tracked && { ...base.tracked, standings: [standingOf(card.id, 8, 8)] },
  };
}

/**
 * One frame of the session — the verdict, and the script moved on by it.
 *
 * `missing` is the `scannerMissing` fault: with no bundle a card is still found in the frame and
 * can never be named, so nothing is ever decided and `decision_seq` never moves.
 */
export function scanStep(
  script: ScanScript,
  mode: ScanMode,
  previews: boolean,
  missing: boolean,
): ScannerVerdict {
  const at = script.frame;
  script.frame += 1;
  const card = FAKE_PILE[Math.floor(at / FRAMES_PER_CARD)];
  const phase = at % FRAMES_PER_CARD;

  if (card === undefined || phase < LOOKING) {
    return framed(VERDICTS.noCard, mode, previews, script.seq);
  }
  if (missing) {
    return framed({ ...VERDICTS.noMatch, matcher: false, tracked: null }, mode, previews, script.seq);
  }
  if (phase < LOOKING + WEIGHING) {
    return framed(weighing(card, phase - LOOKING + 1), mode, previews, script.seq);
  }
  const deciding = phase === LOOKING + WEIGHING;
  if (deciding) script.seq += 1;
  return framed(decided(card, mode, deciding), mode, previews, script.seq);
}

/**
 * The options a frame was sent under, read out of its header — `x-scanner-options`, the JSON
 * `ipc.scannerFrame` writes. `null` where there is none to read: a caller that reached the handler
 * without the IPC layer, which gets the stored mode and no previews.
 */
export function sentOptions(
  options: { headers?: Record<string, string> } | undefined,
): { mode: ScanMode; previews: boolean } | null {
  const raw = options?.headers?.["x-scanner-options"];
  if (raw === undefined) return null;
  const parsed = JSON.parse(raw) as { mode?: unknown; previews?: unknown };
  return { mode: parsed.mode === "exact" ? "exact" : "fast", previews: parsed.previews === true };
}
