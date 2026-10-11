import { STATUS, VERDICTS } from "../fixtures";
import type { ScanFilters, ScannerSubmissionFrame } from "../types";
import type { ScanRun } from "./run";

/**
 * Six pictures for the dialog's stories, oldest first: 64×36 each, a pale card with a red picture
 * on it sliding in from the left across dark felt and coming to rest a little askew. **Drawn, not
 * photographed** — a real camera frame is somebody's desk, and a story file is not where one of
 * those is kept. Between 674 and 880 bytes of JPEG apiece, as the base64 a run carries, so the
 * workbench draws six pictures a reader can tell apart where a test only needs six strings.
 */
export const RUN_PICTURES = [
  "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",
] as const;

/** No narrowing — the reader's filters as a fresh install has them. */
const ANY_PRINTING: ScanFilters = { sets: [], released_from: null, released_to: null };

/** The printing Exact led with in the first run below — one of three it could not split. */
const LED_WITH = VERDICTS.exactAmbiguous.decision?.printing ?? null;

/**
 * What the scanner answered for each of the six pictures as the card came in: nothing found, a
 * card it was still locking on to, one it was weighing, the frame it read with a detail image
 * beside it, and two it had decided on. About nine a second, counted back from the press.
 */
const ANSWERS: Omit<ScannerSubmissionFrame, "jpeg">[] = [
  { ms: -563, ok: false, lock: "idle", confidence: null, distance: null, decided: null, detail: false },
  { ms: -452, ok: true, lock: "acquiring", confidence: 0, distance: 58, decided: null, detail: false },
  { ms: -340, ok: true, lock: "locked", confidence: 0.41, distance: 44, decided: null, detail: false },
  { ms: -229, ok: true, lock: "locked", confidence: 0.78, distance: 38, decided: null, detail: true },
  { ms: -117, ok: true, lock: "locked", confidence: 1, distance: 36, decided: LED_WITH, detail: false },
  { ms: -6, ok: true, lock: "locked", confidence: 1, distance: 36, decided: LED_WITH, detail: false },
];

/**
 * What a press on *Send scan…* froze, two ways.
 *
 * - `wrongPrinting` — Exact could not split three reprints of Lightning Bolt and led with one.
 *   The state the press exists for, and the one whose search finds printings in the workbench's
 *   corpus: its four Bolts are sold one, two, one and three ways, which is every shape the
 *   finish group takes.
 * - `nothingNamed` — the same six pictures with a scanner that found a card in none of them.
 *   Every figure it would have sent is `null`, and the search box opens empty.
 */
export const RUNS = {
  wrongPrinting: {
    frames: RUN_PICTURES.map((jpeg, index) => ({ jpeg, ...ANSWERS[index] })),
    said: {
      reported: LED_WITH,
      mode: "exact",
      confidence: 1,
      distance: 36,
      bundle: STATUS.present.labels,
      filters: ANY_PRINTING,
    },
    leadName: "Lightning Bolt",
  },
  nothingNamed: {
    frames: RUN_PICTURES.map((jpeg, index) => ({
      jpeg,
      ms: ANSWERS[index].ms,
      ok: false,
      lock: "idle" as const,
      confidence: null,
      distance: null,
      decided: null,
      detail: false,
    })),
    said: {
      reported: null,
      mode: "fast",
      confidence: null,
      distance: null,
      bundle: null,
      filters: ANY_PRINTING,
    },
    leadName: "",
  },
} satisfies Record<string, ScanRun>;
