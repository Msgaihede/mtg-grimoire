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
 * The longest a run reaches back, in milliseconds — from its newest frame as the ring keeps it,
 * and from the press as one is taken ({@link runAtPress}).
 *
 * The other two bounds count frames and bytes, and neither is a clock: a pump that stalled — a
 * read that took a second a frame, a host that was slow to answer — holds twenty frames for as
 * long as it takes to send twenty more, and one that stopped answering holds them for good. Those
 * are not *the last couple of seconds*, which is what a reader is told they are sending. About
 * twice what twenty frames span at the pump's ordinary pace, so a slow host still has a run.
 */
export const RUN_MAX_AGE_MS = 4000;

/**
 * **The clock a run is stamped by and read by**: the pump asks it when a frame is drawn off the
 * video (`RunFrame.at`), and a press asks it when it lands ({@link runAtPress}, and each frame's
 * `ms`). Milliseconds on the page's own monotonic clock.
 *
 * **One object, and both sides ask it and nothing else**, so a test can hold it still. A run is
 * a matter of a few seconds ({@link RUN_MAX_AGE_MS}), and a test that parks the pump and then
 * presses would otherwise be racing the machine it runs on: a suite that stalls for longer than
 * that finds a ring of perfectly good frames too old to send. Replacing `now` here moves the stamps
 * and the press together — which a spy on the global clock would also do, along with everything
 * else that reads it.
 *
 * Nothing else is timed by it: the pump's round trips and its rate are the wall's.
 */
export const runClock = { now: (): number => performance.now() };

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
  /** {@link runClock}'s reading as the frame was drawn off the video. */
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
  /**
   * The mode the scanner judged this frame in — `ScannerVerdict.mode`, the session's own word
   * for it and not the page's switch, which moves a frame before the session does.
   *
   * **The ring's, and not the wire's.** A run is judged in one mode or it is not a run — the
   * session forgets the card on the first frame it is sent in another — so the ring starts over
   * where this changes ({@link pushRunFrame}) and a submission says the mode once, for all of it.
   */
  mode: ScanMode;
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
    mode: verdict.mode,
  };
}

/**
 * Add the newest frame to a ring, and drop from the **old** end until it is inside every bound:
 * {@link RUN_MAX_FRAMES}, {@link RUN_MAX_BYTES}, and nothing grabbed more than
 * {@link RUN_MAX_AGE_MS} before the frame being added.
 *
 * **A frame judged in another mode than the one before it starts the ring over.** The session
 * drops its tracker on the first frame it is sent in a new mode, so everything the ring held was
 * said of evidence that frame's answer no longer rests on. This is the one break the pump
 * cannot see for itself — a mode is an option on the frame, not a call of its own — so it is
 * read here, off what the scanner answered.
 *
 * In place, because the ring is the pump's own and nothing else holds it — a reader of it is
 * handed a copy. A frame that is over the byte budget by itself leaves the ring empty, which is
 * the honest answer: there is no run of such frames that could be sent.
 */
export function pushRunFrame(ring: RunFrame[], frame: RunFrame): void {
  if (ring.length > 0 && ring[ring.length - 1].mode !== frame.mode) ring.length = 0;
  ring.push(frame);
  let bytes = ring.reduce((sum, one) => sum + one.jpeg.length, 0);
  while (
    ring.length > 0 &&
    (ring.length > RUN_MAX_FRAMES ||
      bytes > RUN_MAX_BYTES ||
      frame.at - ring[0].at > RUN_MAX_AGE_MS)
  ) {
    bytes -= ring[0].jpeg.length;
    ring.shift();
  }
}

/**
 * The run as a press takes it: the ring's newest stretch, with nothing in it grabbed more than
 * {@link RUN_MAX_AGE_MS} before the press.
 *
 * {@link pushRunFrame} ages the ring against its newest frame, which says nothing of how long
 * ago that frame was: a pump waiting on an answer that is slow, or never comes, goes on holding
 * a ring that was the last couple of seconds once. So the press measures from itself, **before**
 * it counts what is left against {@link RUN_MIN_FRAMES} — too few is the scanner not having been
 * shown enough lately, and it is said in the same sentence.
 *
 * Walked back from the newest frame and stopped at the first one too old, rather than filtered:
 * what is sent is one unbroken stretch of what the pump sent, whatever a clock did.
 */
export function runAtPress(ring: readonly RunFrame[], pressedAt: number): RunFrame[] {
  let from = ring.length;
  while (from > 0 && pressedAt - ring[from - 1].at <= RUN_MAX_AGE_MS) from -= 1;
  return ring.slice(from);
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
 * A {@link ScanRun} from the run a press took ({@link runAtPress}) and the page's state at that
 * moment. Pure, so each rung below is a fixture's worth of test.
 *
 * **What the scanner had said is read off the run's last frame, and never off the verdict a
 * render was holding.** `reported`, `confidence`, `distance` and `mode` are that frame's
 * `decided`, `confidence`, `distance` and `mode`. A press reads the ring as it stands and the
 * verdict as the last render had it, and the ring is a frame ahead of the render whenever an
 * answer has landed since: figures taken from the verdict would then sit beside a last frame
 * that says otherwise, in one submission. So the press-level figures *are* the last frame's, and
 * the two cannot disagree. The `mode` handed in is the page's, and stands only for a run with no
 * frame in it — which no press sends.
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
 * **The name the search opens on is another matter: it is the verdict's, and takes a leader.**
 * It is a word for a box, not a label, and it is not sent — so it comes from what the reader
 * was looking at, which is the verdict the page had drawn: the decision's name when there is
 * one — `matchStrip` names a card by the same order, so the box opens on the name the reader was
 * just shown — else the card the tracker is leaning towards, whose label is its best printing's.
 *
 * `bundle` is how many cards the scanner could have answered with, off the status — `null` where
 * the status has not answered, which is "not asked", never "none". `filters` are the sets and
 * dates it was narrowed to, which decide what it could have answered at all.
 *
 * **A frame goes out field by field, and its `mode` and its clock do not go at all**: the wire
 * says the mode once for the run, and `ms` in place of `at`. Spelled out rather than spread, so
 * a field the ring gains for its own bookkeeping cannot reach the inbox by default.
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
  const last = ring.length > 0 ? ring[ring.length - 1] : null;
  return {
    frames: ring.map((frame) => ({
      jpeg: toBase64(frame.jpeg),
      ms: msBefore(frame.at, pressedAt),
      ok: frame.ok,
      lock: frame.lock,
      confidence: frame.confidence,
      distance: frame.distance,
      decided: frame.decided,
      detail: frame.detail,
    })),
    said: {
      reported: last?.decided ?? null,
      mode: last?.mode ?? mode,
      confidence: last?.confidence ?? null,
      distance: last?.distance ?? null,
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
