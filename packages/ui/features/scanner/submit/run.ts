import { toBase64 } from "@/lib/base64";
import type { Finish } from "@/lib/finish";
import type {
  ScanFilters,
  ScanMode,
  ScannerLockPhase,
  ScannerStatus,
  ScannerSubmission,
  ScannerSubmissionFrame,
  ScannerVerdict,
} from "../types";

/**
 * **A scan is a run of frames, never one picture** (the owner's rule: *all the frames or
 * nothing at all*). The scanner decides over a run — two frames that agree, a tally
 * that reaches its bar, a read on the frame after a lock — so one picture cannot say what it
 * did, and a picture taken *after* the press is not one it was ever shown. What is sent is
 * therefore the last couple of seconds **the scanner was actually given**: the pump's own JPEGs,
 * byte for byte, each beside what it answered.
 *
 * This module is the run on this side of the wire, in its two states — the ring the pump keeps
 * as it goes ({@link RunFrame}, bytes), and the snapshot a press freezes ({@link ScanRun}, the
 * wire's own shape). `useScanLoop` fills the first; `useScanSubmit` makes the second.
 */

/**
 * The most frames a run holds — about two seconds at the nine or so a second the pump sends.
 *
 * ⚠️ **The three bounds here are the engine's too** (`crates/grimoire-core/src/scanner_submit.rs`,
 * which refuses a run it would not keep), and `lib/ipc.test.ts` holds each to its own. Move one
 * here alone and a reader is shown a dialog whose Send can only be refused.
 */
export const RUN_MAX_FRAMES = 20;

/**
 * The most JPEG a run holds, in bytes as the pump made them — before the base64 a press turns
 * them into, which is a third as much again. How much one frame weighs is the camera's and the
 * desk's to say, so on some this binds before {@link RUN_MAX_FRAMES} does: the run is then
 * shorter in frames and no lighter. (Neither bound was measured against a camera here.)
 */
export const RUN_MAX_BYTES = 1.5 * 1024 * 1024;

/**
 * The fewest frames that are a scan — about half a second of the scanner looking. Fewer is a
 * camera that has only just started, or evidence only just reset: nothing to send yet, and the
 * press says so rather than opening a dialog on it.
 */
export const RUN_MIN_FRAMES = 5;

/**
 * One frame the pump sent, as the ring keeps it: the bytes, when they were grabbed, and what the
 * scanner answered for them.
 *
 * **Bytes, not text.** The ring turns over nine times a second and a press comes once in a
 * session, so nothing is encoded until one does ({@link scanRun}). **And the ring's own copy of
 * them** — `useScanLoop` says why the pump cannot keep the array it sends.
 *
 * Entries are never changed once made: `recent()` hands out a fresh array of the same entries,
 * and a snapshot that could be written through would not be one.
 */
export interface RunFrame {
  /** The pump's JPEG, as it went to the scanner. */
  jpeg: Uint8Array;
  /** `performance.now()` as the frame was drawn off the video. */
  at: number;
  /** `ScannerVerdict.ok`: whether a card was found in it at all. */
  ok: boolean;
  /** The lock's phase on this frame, or `null` where the verdict carried no lock. */
  lock: ScannerLockPhase | null;
  /** The tracker's confidence after this frame, or `null` with no tracker. */
  confidence: number | null;
  /** The best candidate's distance in bits on this frame, or `null` with no match. */
  distance: number | null;
  /** The printing the scanner had decided on by this frame, or `null`. */
  decided: string | null;
  /** A detail image went to the scanner with this frame. It is not kept, and never sent. */
  detail: boolean;
}

/**
 * A ring entry from a frame and the verdict the page accepted for it — the one place the
 * per-frame half of a submission is read off a verdict, so the ring and the wire cannot come to
 * read it two ways.
 *
 * `decided` is the decision's printing and never a standing's id, for `reported`'s reason
 * ({@link scanRun}): a standing's id is the oracle card its evidence pooled on, an id of another
 * kind than the printing a reader chooses.
 */
export function runFrameOf(
  jpeg: Uint8Array,
  at: number,
  verdict: ScannerVerdict,
  detail: boolean,
): RunFrame {
  return {
    jpeg,
    at,
    ok: verdict.ok,
    lock: verdict.lock?.phase ?? null,
    confidence: verdict.tracked?.confidence ?? null,
    distance: verdict.match?.candidates[0]?.distance ?? null,
    decided: verdict.decision?.printing ?? null,
    detail,
  };
}

/**
 * Add the newest frame to a ring, and drop from the **old** end until it is inside both bounds.
 *
 * In place, because the ring is the pump's own and nothing else holds it — a reader of it is
 * handed a copy. A frame that is over the byte budget by itself leaves the ring empty, which is
 * the honest answer: there is no run of such frames that could be sent.
 */
export function pushRunFrame(ring: RunFrame[], frame: RunFrame): void {
  ring.push(frame);
  let bytes = ring.reduce((sum, one) => sum + one.jpeg.length, 0);
  while (ring.length > 0 && (ring.length > RUN_MAX_FRAMES || bytes > RUN_MAX_BYTES)) {
    bytes -= ring[0].jpeg.length;
    ring.shift();
  }
}

/**
 * The scanner's side of a submission: every field of {@link ScannerSubmission} that is neither
 * the reader's answer nor the run itself. Named as a slice of that type rather than written out,
 * so a field added to the wire shape is a compile error here until this module says where it
 * comes from.
 */
export type ScannerSaid = Omit<ScannerSubmission, "cardId" | "finish" | "run">;

/**
 * What a press on *Send scan…* froze: the run, and what the scanner was saying at the end of it.
 *
 * **A snapshot, taken once.** The camera and the pump keep running behind the dialog — as they
 * do behind every dialog on the page — so by the time the reader presses Send the ring has
 * turned over and the live verdict is about another card. Everything a submission says is
 * therefore read at the press, and never again.
 */
export interface ScanRun {
  /**
   * The frames, oldest first, each JPEG as standard base64 with no `data:` prefix and each `ms`
   * counted back from the press. **Drawn from the very strings that are sent** — the dialog's
   * pictures are these texts behind a `data:` scheme — so what the reader looks through and what
   * leaves the device cannot be two encodes of one frame. **The last is the card the reader's
   * answer names**: the one under the camera at the press.
   */
  frames: ScannerSubmissionFrame[];
  said: ScannerSaid;
  /**
   * The card the scanner was naming, for the search box to open on — `""` when it named none.
   * **A convenience and never a label**: it is not sent, and it selects nothing. The reader
   * chooses the printing, which is the whole point of asking them.
   */
  leadName: string;
}

/**
 * How long before the press a frame was grabbed, as the wire says it: whole milliseconds, zero
 * or negative. Never positive — a clock that stepped between the grab and the press must not
 * put a frame after the press it was sent for — and never the negative zero a rounding leaves.
 */
function msBefore(at: number, pressedAt: number): number {
  const ms = Math.round(at - pressedAt);
  return ms >= 0 ? 0 : ms;
}

/**
 * A {@link ScanRun} from the ring as it stood at the press and the page's state at that moment.
 * Pure, so each rung below is a fixture's worth of test.
 *
 * **`reported` is the printing the scanner had decided on, and `null` while it had decided
 * nothing.** Never the tracker's leader: a standing's `id` is what its evidence pooled on — the
 * *oracle* id — so sent beside the printing a reader chose it would be an id of another kind,
 * and "the scanner got it right" could never be read off the two (it could not even be right).
 * A committed frame carries the decision on every frame it stays committed, so a reader who
 * sends a card the scanner has settled on sends what it settled on; one who sends while it is
 * still weighing sends `null`, with how far it had got in `confidence` and `distance`. Sent as
 * `null` rather than left out: a scan it had not named is as much worth having as one it named
 * wrongly.
 *
 * **The name the search opens on is another matter, and takes a leader.** It is a word for a
 * box, not a label: the decision's when there is one — `matchStrip` names a card by the same
 * order, so the box opens on the name the reader was just shown — else the card the tracker is
 * leaning towards, whose label is its best printing's.
 *
 * `distance` is the best candidate's, in bits, off the last verdict's own match; `bundle` is
 * how many cards the scanner could have answered with, off the status — `null` where the status
 * has not answered, which is "not asked", never "none". `filters` are the sets and dates it was
 * narrowed to, which decide what it could have answered at all.
 */
export function scanRun(
  ring: readonly RunFrame[],
  pressedAt: number,
  verdict: ScannerVerdict | null,
  mode: ScanMode,
  status: ScannerStatus | null,
  filters: ScanFilters,
): ScanRun {
  const lead = verdict?.tracked?.standings[0];
  return {
    frames: ring.map(({ jpeg, at, ...answered }) => ({
      jpeg: toBase64(jpeg),
      ms: msBefore(at, pressedAt),
      ...answered,
    })),
    said: {
      reported: verdict?.decision?.printing ?? null,
      mode,
      confidence: verdict?.tracked?.confidence ?? null,
      distance: verdict?.match?.candidates[0]?.distance ?? null,
      bundle: status?.labels ?? null,
      filters,
    },
    leadName: verdict?.decision?.label?.name ?? lead?.label?.name ?? "",
  };
}

/** The whole submission: the reader's two answers, what the scanner had said, and the run. */
export function submissionOf(scan: ScanRun, cardId: string, finish: Finish): ScannerSubmission {
  return { cardId, finish, ...scan.said, run: scan.frames };
}
