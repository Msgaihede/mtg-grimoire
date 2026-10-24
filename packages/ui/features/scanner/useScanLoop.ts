import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ipc, ipcError } from "@/lib/ipc";
import { viewMemory } from "@/lib/viewMemory";
import { pushRunFrame, runClock, runFrameOf, type RunFrame } from "./submit/run";
import type { ScannerDecision, ScannerVerdict } from "./types";

// The ring's entry, under the loop's own name for it — a caller of `recent()` has no other
// business in `submit/`.
export type { RunFrame };

/** What the loop has to say: the last verdict, its cost, the running rate, the last failure. */
export interface ScanLoop {
  verdict: ScannerVerdict | null;
  roundTripMs: number | null;
  /** Frames per second over the last twenty round trips. `null` until the first answers. */
  rate: number | null;
  error: string | null;
  /** One frame out of the video, for the capture button. `Infinity` means "do not downscale". */
  grab: (longEdge: number, quality: number) => Promise<Uint8Array | null>;
  /**
   * The last frames the pump sent, oldest first, each with what the scanner answered for it —
   * for *Send scan…*, which sends a run of them (`submit/run.ts`).
   *
   * **Only frames whose verdict the page took**: one whose answer was thrown away — the camera
   * stopped under it, the evidence was cleared, a reset was in flight — or whose call was refused
   * is not in it, so the run is exactly what the scanner's answers on screen were made from.
   * **And never across a break in the evidence**: emptied by {@link ScanLoop.clearReads} and
   * {@link ScanLoop.reset}, and whenever the pump starts or stops, so a run cannot span a reset,
   * a Stop or two camera streams. **Nor across the break the session makes by itself**, which
   * nothing above sees: it forgets the card when it takes a changed set of *filters* — the
   * page's to say, with {@link ScanLoop.breakRun}. And never further back than a few seconds
   * before its newest frame (`RUN_MAX_AGE_MS`).
   *
   * A function and not a value, because the ring is a ref: it turns over nine times a second and
   * nothing draws it. Each call hands back a fresh array of the same entries — a snapshot, which
   * a frame that lands afterwards is not in.
   */
  recent: () => readonly RunFrame[];
  /**
   * **The run starts over here, and nothing else does**: the frames kept so far are let go, and a
   * frame already on its way to the scanner does not join the ones after it.
   *
   * For the break the pump cannot see: the session took a changed set of filters, and dropped its
   * tracker to do it. Every frame the ring holds was judged under the old ones, and a run sent
   * across the change would be labelled with filters its first frames were never searched under.
   * The page calls this when the filters in force change (`useScannerPrefs`' `inForce`).
   *
   * **Not {@link ScanLoop.clearReads}.** The session reset itself; nothing on screen is stale. So
   * the verdict and the decision edge are left exactly as they are, and a frame
   * in flight still has its answer taken and drawn — it is only kept out of the run, because it
   * may have been judged on either side of the change. Stable, like `recent`.
   */
  breakRun: () => void;
  /**
   * Throw the current verdict and the run away, ignoring unfinished frames.
   *
   * The Reset press's other half: `scanner_reset` drops the agreement's evidence in the crate,
   * and the verdict and the run are evidence this side is holding. Leaving them would show a
   * card the reader has just asked the scanner to forget.
   */
  clearReads: () => void;
  /** Clear visible evidence, drain the old frame, then reset the session before scanning again. */
  reset: () => Promise<void>;
}

/** How a frame becomes JPEG bytes. Injectable because jsdom has no canvas pixels to draw on. */
export type GrabFrame = (
  video: HTMLVideoElement,
  longEdge: number,
  quality: number,
) => Promise<Uint8Array | null>;

/**
 * One video frame as the pump wants it when it keeps full frames for a run: the frame it sends,
 * and `kept`, the same draw at the camera's resolution up to {@link EVIDENCE_MAX_WIDTH} wide —
 * `null` where that encode produced nothing, and the run then keeps the pump's own frame.
 */
export interface GrabbedKept {
  frame: Uint8Array;
  kept: Uint8Array | null;
}

/**
 * How a frame becomes that pair. A seam of its own beside {@link GrabFrame} rather than a wider
 * `GrabFrame`, so the capture button's `grab(Infinity, 0.92)`, a page that keeps no full frames,
 * and every test that injects only a single grab keep the shape they had.
 */
export type GrabKept = (
  video: HTMLVideoElement,
  longEdge: number,
  quality: number,
) => Promise<GrabbedKept | null>;

/**
 * The widest a frame kept for *Send scan…* is — the owner's decision, 2026-10-22: **scans are
 * collected at full resolution**, capped at 1920 pixels wide, because a picture can always be
 * brought down to the scanner's size when it is used and never brought up. A 1920×1080 camera —
 * `useCamera`'s ideal — is kept whole.
 */
export const EVIDENCE_MAX_WIDTH = 1920;

/**
 * The long edge a frame is brought down to before it is sent. The recogniser's detector works on
 * a picture smaller than this, so a larger frame is an encode and a body paid for nothing.
 */
export const SEND_PX = 960;

/** The quality the pump sends at. The capture button uses 0.92 — see {@link ScanLoop.grab}. */
const PUMP_QUALITY = 0.72;
/**
 * A kept frame's JPEG quality — above {@link PUMP_QUALITY} because the fine print is the point of
 * keeping the frame large: set symbols, collector numbers, a title's serifs.
 */
const EVIDENCE_QUALITY = 0.85;
/** The idle wait between two looks at a video that has nothing new, matching the debug page. */
const IDLE_MS = 16;
/** How many round trips the rate averages over. */
const WINDOW = 20;
/**
 * A decision this many frames or fewer after the one before it is not a second card, and is not
 * passed on (issue #735).
 *
 * The session can decide twice in a row on one physical card: it calls a card *changed* on two
 * frames that look unlike the decided one, so a card still settling — or a camera still moving —
 * is decided again two frames after its first decision, three when that decision waits a frame
 * for its confirming read. A card a reader really did swap in needs the old one lifted, the new
 * one laid down and at least three frames of its own, which is more than this at any frame rate.
 *
 * **Frames, not milliseconds.** The session works in frames and the pump runs anywhere from
 * five to a dozen a second, so a clock would be one machine's number: long enough to catch a
 * three-frame pair on a slow build is long enough to swallow a real card on a fast one.
 *
 * **The first of the two stays.** Nothing here can tell which read was the better one, and the
 * row already in the tray is the one the reader has seen land.
 */
export const DECISION_GAP_FRAMES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Which card a decision names, by the session's own rule for a second opinion
 * (`Session::replaces_previous`): the oracle card, or the printing where the corpus has no oracle.
 */
function identityOf(decision: ScannerDecision): string {
  return decision.oracle_id ?? decision.printing;
}

/**
 * **The card standing in front of the lens when this window's last pump stopped** — the identity
 * of the last decision a taken verdict carried, until a taken verdict had no card in it (issue
 * #1318). `null` for none.
 *
 * Module memory (`viewMemory`, window-lifetime) rather than a ref, because the pump that reads it
 * is often not the pump that wrote it: a view switch unmounts the page, and the Scanner the reader
 * comes back to is a new hook over the same session. See `useScanLoop`'s note on a start.
 */
const standingCard = viewMemory<string | null>("scanner.standing-card");

/**
 * The frame pump — one request in flight, every frame that arrives under it dropped.
 *
 * **The camera runs at 30–60 fps and the detector at roughly 9, and keeping the two apart is
 * the whole design.** Queuing the frames the detector cannot keep up with would make the
 * overlay drift further behind the longer a reader watched it, so a frame taken while a request
 * is outstanding is thrown away rather than sent. `inFlightRef` rather than a loop-local flag
 * because the guarantee has to survive a restart: toggling `live` off and on again while a
 * request is still outstanding would otherwise put a second one on the wire beside it.
 *
 * **A pump that starts resets the session before its first frame** (issue #1318). The session
 * outlives every pump — a Stop, a view switch, a minimized window and both of the page's dialogs
 * stop one — and it judges each frame against what it saw last. What it saw last is a card from
 * before the gap, and it never saw that card leave: no empty frame went past it. So a card laid
 * down while the pump was stopped was weighed as a swap under a frozen decision — late — and one
 * the session decided on the stream's very first frames was taken for the old decision still
 * standing. Reset, every frame of the stream is judged on its own, and a card already in front of
 * the lens is decided and added like one laid down a moment later.
 *
 * **Except the card that was standing when the last pump stopped** ({@link standingCard}). That
 * one is in the tray already, and resuming over it — closing a dialog, restoring the window,
 * coming back to the view — must not file it a second time. So the first decision of a stream
 * that names it is taken quietly, unless a frame with no card in it came first: then it was
 * lifted and laid down again, which is a card of its own. A second copy of one card, swapped in
 * while the pump was stopped, cannot be told from the first; Reset makes it news.
 *
 * **And the pump keeps the last couple of seconds of what it sent** — `recent()`, for *Send
 * scan…*. A scan is a run of frames and never one picture, and the only run worth sending is
 * the one the scanner was really given: these frames, in this order, each beside the verdict it
 * got — **and at full resolution where the page may send them**
 * (`keepFullFrames`): each frame is then drawn off the video once, at up to
 * {@link EVIDENCE_MAX_WIDTH} wide, and the pump's frame is made from that same draw, so the
 * picture kept and the picture judged are one moment of the video. That costs one more encode a
 * frame, which is why a page that cannot send pays none of it. Nothing is turned into text until
 * a reader presses.
 */
export function useScanLoop({
  videoRef,
  live,
  grabFrame = defaultGrabFrame,
  grabKept = defaultGrabKept,
  keepFullFrames = false,
  onDecision,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  live: boolean;
  grabFrame?: GrabFrame;
  /** The grab every frame uses while `keepFullFrames` is on. Injectable for {@link GrabFrame}'s reason. */
  grabKept?: GrabKept;
  /**
   * Keep each frame of the run at full resolution — the page's word that *Send scan…* may be
   * offered (`useMaySendScans`), so a reader who can never send pays nothing for it. Read
   * through a ref; a change starts the run over, because a run is one size.
   */
  keepFullFrames?: boolean;
  /**
   * The session decided on a card — called once per new `decision_seq`, with the decision and
   * the number, and never for a repeat.
   *
   * **A start resets the session, and the card it was standing on is not news** (issue #1318):
   * every decision of a new stream is passed on — its very first frame's too — but one naming the
   * card the last stream stopped on, before any frame without a card, which is that card still
   * lying there. Should the reset be refused, the first number is a baseline instead, as it was
   * before: a card frozen across the gap rides every committed frame of the new stream. Read
   * through a ref, so a page passing a fresh closure each render does not restart the pump.
   *
   * **Nor is a number that moves again within {@link DECISION_GAP_FRAMES} frames**: that is the
   * session deciding one card twice, and the second is dropped.
   */
  onDecision?: (decision: ScannerDecision, seq: number) => void;
}): ScanLoop {
  const [verdict, setVerdict] = useState<ScannerVerdict | null>(null);
  const [roundTripMs, setRoundTripMs] = useState<number | null>(null);
  const [rate, setRate] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Latched in a layout effect for `QrScanner`'s reason: the ref has to be current before the
  // next tick of a loop that mounted once and must not restart, and `useEffect` alone is not
  // guaranteed to run before that.
  const grabRef = useRef(grabFrame);
  const grabKeptRef = useRef(grabKept);
  const keepFullRef = useRef(keepFullFrames);
  const onDecisionRef = useRef(onDecision);
  useLayoutEffect(() => {
    grabRef.current = grabFrame;
    grabKeptRef.current = grabKept;
    onDecisionRef.current = onDecision;
  });

  const inFlightRef = useRef(false);
  const tripsRef = useRef<number[]>([]);
  /**
   * The `decision_seq` of the last verdict this loop took, or `null` before the first one since the
   * camera started — which makes that first number a baseline when the start's reset was refused
   * (see `onDecision`). A ref and not state: nothing draws it, and it has to be current for the
   * very next answer rather than for the next render.
   */
  const lastSeqRef = useRef<number | null>(null);
  /**
   * The card this stream must not file again — {@link standingCard} as the pump found it when it
   * started — until a frame has no card in it or the stream's first decision has been seen. A ref
   * for `lastSeqRef`'s reason.
   */
  const heldRef = useRef<string | null>(null);
  /**
   * Verdicts since the last decision, the one that carried it not counted — `Infinity` until the
   * camera's first, so a session's first card is never inside the gap. Counted from **every**
   * decision, a dropped one included: a session flapping between two answers every other frame
   * would otherwise get every second one through.
   */
  const sinceDecisionRef = useRef(Infinity);
  const evidenceRef = useRef(0);
  const pendingFrameRef = useRef<Promise<void> | null>(null);
  const resetRef = useRef<Promise<void> | null>(null);
  /**
   * The run: the last frames this pump sent and had answered, oldest first (`submit/run.ts` has
   * its bounds). A ref for `lastSeqRef`'s reason, more so — it changes with every frame, nothing
   * draws it, and the one reader wants it as it stands at a press rather than at the last render.
   *
   * **Emptied wherever the evidence is** — `clearReads`, and the pump's start and its stop — and
   * a frame in flight across any of those never reaches it: it is added on the line that takes
   * the verdict, behind the same two checks. **And at the session's own break**, which leaves
   * this side's evidence standing: `breakRun` empties it when the session takes changed filters —
   * with `runEpochRef` keeping out the frame in flight across that one.
   */
  const runRef = useRef<RunFrame[]>([]);
  /**
   * Which run a frame belongs to: moved by `breakRun` and by nothing else. A frame notes it as it
   * is sent and joins the ring only if it has not moved by the time its verdict is taken.
   *
   * **A counter of the ring's own, and deliberately not `evidenceRef`.** That one throws the
   * frame's *answer* away — right for a reset, where the answer is about a card the reader asked
   * the scanner to forget. A change of filters stales nothing on screen, so the answer is kept
   * and drawn, and only the frame's place in the run is refused.
   */
  const runEpochRef = useRef(0);

  const recent = useCallback((): readonly RunFrame[] => runRef.current.slice(), []);

  const breakRun = useCallback(() => {
    runEpochRef.current += 1;
    runRef.current = [];
  }, []);

  /**
   * Moved each time the page starts or stops keeping full frames. A frame notes it as it is
   * grabbed — not as it is sent, which is `runEpochRef`'s moment: the size of the picture is
   * settled by the grab.
   */
  const keptSizeRef = useRef(0);
  // **A run is one size of picture**: a page that starts or stops keeping full frames starts the
  // run over, and a frame grabbed under the old word is kept out of the new run.
  useLayoutEffect(() => {
    if (keepFullRef.current === keepFullFrames) return;
    keepFullRef.current = keepFullFrames;
    keptSizeRef.current += 1;
    breakRun();
  }, [keepFullFrames, breakRun]);

  const clearReads = useCallback(() => {
    // A grab or IPC answer already outstanding belongs to the evidence being discarded (#781).
    // Clearing state alone lets that answer put the old card straight back on the screen.
    evidenceRef.current += 1;
    setVerdict(null);
    sinceDecisionRef.current = Infinity;
    // A reader who pressed Reset asked for the next decision to be news — the card in front of
    // the lens included.
    heldRef.current = null;
    standingCard.keep(null);
    // The frames are evidence too: a run sent after a reset must not open on the card the
    // reader has just asked the scanner to forget.
    runRef.current = [];
  }, []);

  /**
   * `scanner_reset`, once: a reset already on its way is joined rather than sent twice. Shared by
   * the Reset press and the pump's start.
   */
  const resetSession = useCallback((): Promise<void> => {
    if (resetRef.current !== null) return resetRef.current;
    // Pause synchronously, then drain before invoking: Tauri's blocking tasks need not take
    // the session mutex in invocation order. An old frame must never run AFTER this reset.
    const pending = Promise.resolve().then(async () => {
      try {
        await pendingFrameRef.current;
        await ipc.scannerReset();
      } finally {
        resetRef.current = null;
      }
    });
    resetRef.current = pending;
    return pending;
  }, []);

  const reset = useCallback(() => {
    // Cleared even when a reset is already on its way — the pump's own, at a start — because
    // that one keeps the card standing, and this press is the reader's asking it not to.
    clearReads();
    return resetSession();
  }, [clearReads, resetSession]);

  const grab = useCallback(
    async (longEdge: number, quality: number): Promise<Uint8Array | null> => {
      const video = videoRef.current;
      if (video === null) return null;
      return grabRef.current(video, longEdge, quality);
    },
    [videoRef],
  );

  useEffect(() => {
    if (!live) return;
    let stopped = false;
    // A camera that has just started has seen no number yet; see `lastSeqRef`.
    lastSeqRef.current = null;
    sinceDecisionRef.current = Infinity;
    // Nor has it sent a frame: a run is one stream's, start to press.
    runRef.current = [];
    // The card the last stream stopped on, which this one must not file again.
    heldRef.current = standingCard.recall() ?? null;

    async function pump() {
      // **The session forgets what it saw before this stream** (issue #1318) — see the hook's
      // note. Awaited ahead of the first grab, so no frame of this stream is judged against the
      // last one's; `resetRef` holds the idle loop below off it meanwhile. A refusal is said and
      // the pump runs on: the frames would be refused for the same reason, and say so too.
      let fresh = false;
      try {
        await resetSession();
        fresh = true;
      } catch (e) {
        if (!stopped) setError(ipcError(e));
      }
      while (!stopped) {
        const video = videoRef.current;
        // `readyState < 2` is `HAVE_CURRENT_DATA` unmet — there is no frame to draw yet.
        if (
          video === null ||
          inFlightRef.current ||
          resetRef.current !== null ||
          video.readyState < 2
        ) {
          await sleep(IDLE_MS);
          continue;
        }
        // **The grab has a `catch` of its own, and running without one froze the scanner
        // silently.** `drawImage` throws on a tainted canvas and `toBlob` can fail under
        // memory pressure; outside a `try` either one rejects `pump()` itself, which ends
        // the loop with `error` still `null` — a picture that keeps moving, an overlay that
        // never updates again, and nothing anywhere saying why. Its own block rather than
        // the request's below, because a frame that never became bytes was never in flight.
        let bytes: Uint8Array | null;
        const evidence = evidenceRef.current;
        /** The full-resolution copy the run keeps, where the page keeps one. */
        let full: Uint8Array | null = null;
        // Which size of picture the grab is for — see `keptSizeRef`.
        const keptSize = keptSizeRef.current;
        // When this frame is the video's: both grabs draw it on the call and encode afterwards,
        // so the clock is read before the call and not when the bytes come back. The run's own
        // clock (`runClock`), which is the one a press reads; the round trip below is the wall's.
        const grabbedAt = runClock.now();
        try {
          if (keepFullRef.current) {
            const got = await grabKeptRef.current(video, SEND_PX, PUMP_QUALITY);
            bytes = got?.frame ?? null;
            full = got?.kept ?? null;
          } else {
            bytes = await grabRef.current(video, SEND_PX, PUMP_QUALITY);
          }
        } catch (e) {
          if (!stopped && evidence === evidenceRef.current) setError(ipcError(e));
          await sleep(IDLE_MS);
          continue;
        }
        // JPEG encoding can finish after the camera stops or restarts. That old pump must
        // not submit its frame to the session now owned by the new stream.
        if (stopped) return;
        if (evidence !== evidenceRef.current || resetRef.current !== null) continue;
        if (bytes === null) {
          await sleep(IDLE_MS);
          continue;
        }

        inFlightRef.current = true;
        let drained!: () => void;
        pendingFrameRef.current = new Promise<void>((resolve) => {
          drained = resolve;
        });
        // **The run's own copy of the frame, taken before the call and never after it.** The web
        // host hands a frame to its scanner's Worker by *transferring* its buffer
        // (`lib/core/web/scanner.ts`), which leaves the array this side holds detached and
        // zero-length the moment the call is made. A ring that kept `bytes` would be full of
        // frames on the desktop and full of nothing in a browser, with no error anywhere — so it
        // keeps a copy, on every host alike. A frame's worth of bytes copied nine times a second,
        // which is small beside the encode that made them. **The full-resolution frame needs no
        // copy**: it is never sent to the scanner, so nothing can detach it; and one grabbed
        // across a change of `keepFullFrames` is not this run's size, and is kept out of it.
        const sameSize = keptSize === keptSizeRef.current;
        const kept = full ?? bytes.slice();
        // Which run this frame is sent into — see `runEpochRef`. Noted here, as it goes out, and
        // not at the grab: a frame grabbed before a break and sent after it is judged after it.
        const epoch = runEpochRef.current;
        const t0 = performance.now();
        try {
          const answer = await ipc.scannerFrame(bytes);
          const ms = performance.now() - t0;
          const trips = tripsRef.current;
          trips.push(ms);
          if (trips.length > WINDOW) trips.shift();
          if (stopped) return;
          if (evidence !== evidenceRef.current) continue;
          setRoundTripMs(ms);
          setRate((1000 * trips.length) / trips.reduce((a, b) => a + b, 0));
          setVerdict(answer);
          // The frame joins the run exactly where its verdict is taken, and nowhere else: a
          // frame whose answer was dropped above, or refused below, was never part of what the
          // scanner is seen to have said. Nor does one that was on the wire across `breakRun`:
          // its answer is drawn like any other, and it belongs to neither run.
          if (sameSize && epoch === runEpochRef.current) {
            pushRunFrame(runRef.current, runFrameOf(kept, grabbedAt, answer));
          }
          setError(null);
          // A card that has left is not the one the last stream stopped on any more, for this
          // stream or the next — see `standingCard`.
          if (answer.quad === null) {
            heldRef.current = null;
            standingCard.keep(null);
          } else if (answer.decision !== null) {
            standingCard.keep(identityOf(answer.decision));
          }
          // The decision edge. The ref moves on every verdict — a frame that repeats the number
          // is the frozen card still in front of the lens, and one with no decision is a card
          // nobody has settled on — and only a number that differs from the last one, on a frame
          // carrying the decision, is an add — unless it comes too soon after the last one to be
          // a second card (`DECISION_GAP_FRAMES`). The stream's first verdict has no number
          // before it: after the start's reset nothing it carries can be the old decision, so
          // its decision is news; without that reset its number is the baseline.
          const seenSeq = lastSeqRef.current;
          lastSeqRef.current = answer.decision_seq;
          sinceDecisionRef.current += 1;
          const moved = seenSeq === null ? fresh : answer.decision_seq !== seenSeq;
          if (moved && answer.decision !== null) {
            const gap = sinceDecisionRef.current;
            sinceDecisionRef.current = 0;
            // The stream's first decision, naming the card its start found standing: that card,
            // still lying where it was, and already in the tray.
            const held = heldRef.current;
            heldRef.current = null;
            if (gap > DECISION_GAP_FRAMES && held !== identityOf(answer.decision)) {
              onDecisionRef.current?.(answer.decision, answer.decision_seq);
            }
          }
        } catch (e) {
          // The loop does not stop on a failure. A recogniser that has not loaded rejects every
          // frame the same way, and one that loads mid-session — the web host's files arriving —
          // should see the scanner recover on its own rather than have to leave the page.
          if (!stopped && evidence === evidenceRef.current) setError(ipcError(e));
        } finally {
          inFlightRef.current = false;
          pendingFrameRef.current = null;
          drained();
        }
      }
    }

    void pump();
    return () => {
      stopped = true;
      // A stopped pump's frames are not a run anyone can send: the next press belongs to a
      // stream that has not started yet.
      runRef.current = [];
    };
    // `videoRef` and `resetSession` are stable by construction; everything else the loop reads
    // is behind a ref.
  }, [live, videoRef, resetSession]);

  return {
    verdict,
    roundTripMs,
    rate,
    error,
    grab,
    recent,
    breakRun,
    clearReads,
    reset,
  };
}

/**
 * One canvas, made on first use and never re-created — a fresh one per frame would be a texture
 * allocation nine times a second.
 */
let scratch: HTMLCanvasElement | null = null;

/**
 * Video → downscaled JPEG bytes.
 *
 * `longEdge` caps the *long* edge rather than the width, so a portrait camera sends the same
 * pixel budget as a landscape one; `Math.min(1, …)` makes it a cap and never an upscale, which
 * is what lets the capture button ask for `Infinity` and get the sensor's own resolution.
 */
async function defaultGrabFrame(
  video: HTMLVideoElement,
  longEdge: number,
  quality: number,
): Promise<Uint8Array | null> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w === 0 || h === 0) return null;
  // Bound to a `const` as it is assigned, so the callback below has a canvas rather than a
  // module-level `let` TypeScript has to re-narrow: `scratch?.toBlob` was the optional chain
  // that admission cost, and an optional chain here would silently resolve nothing.
  const canvas = (scratch ??= document.createElement("canvas"));
  const scale = Math.min(1, longEdge / Math.max(w, h));
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return jpegOf(canvas, quality);
}

/** The canvas {@link defaultGrabKept} draws the video on — {@link scratch}'s reason. */
let keptScratch: HTMLCanvasElement | null = null;

/** `from` drawn onto `canvas` at `w`×`h`, or `null` where the canvas has no 2D context. */
function drawn(
  canvas: HTMLCanvasElement,
  from: CanvasImageSource,
  w: number,
  h: number,
): HTMLCanvasElement | null {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.drawImage(from, 0, 0, w, h);
  return canvas;
}

/**
 * Video → the frame and the full-resolution copy the run keeps — out of **one** draw of the
 * video: a picture kept beside a verdict must be the picture that verdict was about. A second
 * `drawImage(video)` reads whatever frame the element holds at that moment, which at 30–60 fps
 * can already be the next one.
 *
 * The video is drawn once, up to {@link EVIDENCE_MAX_WIDTH} wide, and the frame is drawn from that
 * canvas. Both encodes are started before either is awaited: `toBlob` takes its copy of the bitmap
 * when it is called, so neither result depends on what later draws do to the shared canvases.
 */
async function defaultGrabKept(
  video: HTMLVideoElement,
  longEdge: number,
  quality: number,
): Promise<GrabbedKept | null> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w === 0 || h === 0) return null;
  const keptScale = Math.min(1, EVIDENCE_MAX_WIDTH / w);
  const source = drawn(
    (keptScratch ??= document.createElement("canvas")),
    video,
    Math.max(1, Math.round(w * keptScale)),
    Math.max(1, Math.round(h * keptScale)),
  );
  if (source === null) return null;
  const scale = Math.min(1, longEdge / Math.max(source.width, source.height));
  const small = drawn(
    (scratch ??= document.createElement("canvas")),
    source,
    Math.max(1, Math.round(source.width * scale)),
    Math.max(1, Math.round(source.height * scale)),
  );
  if (small === null) return null;
  const [frame, kept] = await Promise.all([
    jpegOf(small, quality),
    jpegOf(source, EVIDENCE_QUALITY),
  ]);
  if (frame === null) return null;
  return { frame, kept };
}

/** A canvas's pixels as JPEG bytes, or `null` where the browser produced no blob. */
async function jpegOf(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array | null> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", quality),
  );
  if (blob === null) return null;
  return new Uint8Array(await blob.arrayBuffer());
}
