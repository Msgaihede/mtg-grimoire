/**
 * What the fake's camera "sees": a short pile of cards, laid down one at a time.
 *
 * **Until step 7.6 `scanner_frame` answered the decided fixture on every frame**, with a
 * `decision_seq` that never moved — and `useScanLoop` takes the first number it sees as a baseline,
 * so over the fake a live camera never added a card. Nothing could drive the reader's half of the
 * Scanner without the real engine: not a story with a camera, not `mobile:dev`, not a smoke. This
 * is the script that replaced it — a believable session a frame at a time, so the page, its
 * stories and `scripts/phone-scanner-smoke.ts` have cards landing in the tray.
 *
 * **One card is thirteen frames**: nothing in frame, the agreement weighing it, the frame that
 * decides (the one that moves `decision_seq`), and the card lying there decided until it is lifted.
 * The decided card rides every held frame with the *same* number, as the session's does — which is
 * what makes "one add per card" a property the page has to honour rather than one the fake hands
 * it. After the last card the camera looks at an empty desk; `scanner_reset` lays the pile down
 * again, and the number it has reached survives that, as the crate's does.
 *
 * **The pile is the tray's shapes, in the Storybook corpus's own printings** (so every row draws
 * its art): Urza's Saga twice — printed nonfoil and foil, so under *Detect* each lands `Unknown`
 * for the reader to pick, and under a set finish the second is a bump to ×2 — then two printings
 * sold one way (Ancient Tomb, Black Lotus), which *Detect* files nonfoil, and Lightning Bolt — whose
 * picture stands for all three of its printings, so the scanner answers it `ambiguous` with the
 * three as its choices and the row waits on a pick.
 *
 * **What it does not do**: it ignores the filters, and the quad it reports is the fixture's
 * whatever the camera shows. Those are the engine's to prove.
 */
import { VERDICTS } from "@grimoire/ui/features/scanner/fixtures";
import type {
  ScannerChoice,
  ScannerDecision,
  ScannerLabel,
  ScannerStanding,
  ScannerVerdict,
} from "@grimoire/ui/lib/ipc";
import { CARDS } from "./cards";

/**
 * How long one fake frame takes to answer. The real round trip is about 110–200 ms (a release
 * build, `card-scanner.md` §9 *Measured in the app*); answered at once, a browser's pump would
 * send sixty frames a second and lay the whole pile down in under a second.
 */
export const FAKE_FRAME_MS = 110;

/** Frames with nothing in frame before a card is laid down. */
const LOOKING = 3;
/** Frames the agreement spends weighing it. */
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
  /** The printing the scanner names first. */
  id: string;
  /** The other printings its matched picture stands for — none for a picture of one printing. */
  rivals: readonly string[];
}

/** The cards on the desk, in the order they are laid down. */
export const FAKE_PILE: readonly PileCard[] = [
  { id: SAGA, rivals: [] },
  { id: SAGA, rivals: [] },
  { id: TOMB, rivals: [] },
  { id: LOTUS, rivals: [] },
  { id: BOLT_2X2, rivals: [BOLT_STA, BOLT_SLD] },
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
  if (card === undefined)
    throw new Error(`the fake scanner's pile names a printing the corpus lost: ${id}`);
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

/** A verdict with the session's number on it. */
function numbered(verdict: ScannerVerdict, seq: number): ScannerVerdict {
  return { ...verdict, decision_seq: seq };
}

/** A card in frame, the agreement `n` frames into weighing it. */
function weighing(card: PileCard, n: number): ScannerVerdict {
  const base = VERDICTS.voting;
  const confidence = n / (WEIGHING + 1);
  return {
    ...base,
    match: base.match && {
      ...base.match,
      candidates: [
        { id: card.id, distance: 30, normalized: 0.11, label: labelOf(card.id), printings: 1 },
      ],
      margin: null,
    },
    tracked: base.tracked && {
      ...base.tracked,
      confidence,
      streak: n,
      frames: n,
      misses: 0,
      // Short of the bar on the last weighing frame, so the bar is never full before the frame
      // that decides.
      standings: [standingOf(card.id, confidence * base.tracked.decide_at, n)],
    },
  };
}

/**
 * The printings the matched picture stands for, the one it names first — each at the picture's
 * own distance, since it is one picture that matched them all.
 */
function lookOf(card: PileCard): ScannerChoice[] {
  return [card.id, ...card.rivals].map((id) => choiceOf(id, 0.071));
}

/**
 * What the scanner decides on a card: choices only when its picture stands for more than one
 * printing — `ambiguous`, with them as the choices — and `resolved` with none otherwise.
 */
function decisionOf(card: PileCard): ScannerDecision {
  const ambiguous = card.rivals.length > 0;
  return {
    printing: card.id,
    oracle_id: corpusCard(card.id).oracleId,
    label: labelOf(card.id),
    outcome: ambiguous ? "ambiguous" : "resolved",
    choices: ambiguous ? lookOf(card) : [],
    replaces_previous: false,
    finishes: finishesOf(card.id),
  };
}

/** The card decided: on the deciding frame and on every held one after. */
function decided(card: PileCard): ScannerVerdict {
  const base = VERDICTS.decided;
  return {
    ...base,
    decision: decisionOf(card),
    match: base.match && {
      ...base.match,
      candidates: [
        { id: card.id, distance: 30, normalized: 0.11, label: labelOf(card.id), printings: 1 },
      ],
    },
    tracked: base.tracked && {
      ...base.tracked,
      standings: [standingOf(card.id, base.tracked.decide_at, base.tracked.decide_at)],
    },
  };
}

/** What every frame says with no models loaded — `NEURAL_UNAVAILABLE_ERROR`, verbatim. */
export const MODELS_NOT_LOADED = "the Neural scanner's models are not loaded";

/**
 * One frame of the session — the verdict, and the script moved on by it.
 *
 * `missing` is the `scannerMissing` fault: with no models loaded every frame fails, in the
 * crate's sentence, so nothing is ever decided and `decision_seq` never moves.
 */
export function scanStep(script: ScanScript, missing: boolean): ScannerVerdict {
  if (missing) {
    return numbered(
      { ...VERDICTS.panicked, error: MODELS_NOT_LOADED, matcher: false, read_ms: 0 },
      script.seq,
    );
  }
  const at = script.frame;
  script.frame += 1;
  const card = FAKE_PILE[Math.floor(at / FRAMES_PER_CARD)];
  const phase = at % FRAMES_PER_CARD;

  if (card === undefined || phase < LOOKING) return numbered(VERDICTS.noCard, script.seq);
  if (phase < LOOKING + WEIGHING) {
    return numbered(weighing(card, phase - LOOKING + 1), script.seq);
  }
  if (phase === LOOKING + WEIGHING) script.seq += 1;
  return numbered(decided(card), script.seq);
}
