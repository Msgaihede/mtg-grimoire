import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ipc, ipcError } from "@/lib/ipc";
import type {
  ScannerCollector,
  ScannerDecision,
  ScannerOcr,
  ScannerOptions,
  ScannerResolution,
  ScannerVerdict,
} from "./types";

/** What the loop has to say: the last verdict, its cost, the running rate, the last failure. */
export interface ScanLoop {
  verdict: ScannerVerdict | null;
  /**
   * The last title read, kept across every frame that carried none.
   *
   * **The readers run on one eligible frame in four and stop once the tracker has decided**
   * (`session::OCR_EVERY`), so `verdict.ocr` is `null` on most frames — a panel drawing it
   * straight off the current verdict says "nothing read" three frames in four, on a tier that
   * read the card perfectly well a hundred milliseconds ago. `live.html` keeps a `lastOcr` for
   * exactly this reason, and this is the same latch on this side.
   */
  lastOcr: ScannerOcr | null;
  /** The last collector-line read, kept for {@link ScanLoop.lastOcr}'s reason. */
  lastCollector: ScannerCollector | null;
  /**
   * The last Exact resolve, kept until a frame has **no card** in it.
   *
   * A resolve is reported on the one frame it ran on, so `verdict.resolution` is `null` on every
   * frame after it — and the status line's *Pick a printing below* and the Tiers panel both have
   * to outlive that frame for as long as the same card is in front of the lens. Latched here
   * beside the two reads rather than in the page, for their reason: the write lands in the same
   * batch as the verdict, so a frame still costs one commit. Cleared on a frame whose `quad` is
   * `null`, because a card that has left takes its resolve with it; and by `clearReads` and a
   * camera change, like the reads.
   */
  lastResolution: ScannerResolution | null;
  roundTripMs: number | null;
  /** Frames per second over the last twenty round trips. `null` until the first answers. */
  rate: number | null;
  error: string | null;
  /** One frame out of the video, for the capture button. `Infinity` means "do not downscale". */
  grab: (longEdge: number, quality: number) => Promise<Uint8Array | null>;
  /**
   * Throw the current verdict and all kept reads away, ignoring unfinished frames.
   *
   * The Reset press's other half: `scanner_reset` drops the tracker's evidence in the crate,
   * and the latches above are evidence this side is holding. Leaving them would show a
   * title the reader has just asked the scanner to forget.
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
 * One video frame as the pair a read wants: the usual `longEdge` JPEG the crate detects on, and
 * the same frame near the camera's own resolution that it warps the title and collector bands out
 * of. `detail` is `null` where the camera is no larger than the frame, since a detail image the
 * size of the frame would be the frame twice.
 */
export interface GrabbedPair {
  frame: Uint8Array;
  detail: Uint8Array | null;
}

/**
 * How a frame becomes that pair. A seam of its own beside {@link GrabFrame} rather than a wider
 * `GrabFrame`, so the capture button's `grab(Infinity, 0.92)` and every test that injects only a
 * single grab keep the shape they had.
 */
export type GrabPair = (
  video: HTMLVideoElement,
  longEdge: number,
  quality: number,
) => Promise<GrabbedPair | null>;

/** The quality the pump sends at. The capture button uses 0.92 — see {@link ScanLoop.grab}. */
const PUMP_QUALITY = 0.72;
/**
 * The detail image's long edge, at most. A 1920×1080 camera — `useCamera`'s ideal — goes out
 * whole; a 4K one is brought down to what the band reads can use rather than encoding eight
 * megapixels on the frame that can least afford the wait.
 */
const DETAIL_LONG_EDGE = 2560;
/**
 * The detail image's JPEG quality — above {@link PUMP_QUALITY} because it exists to carry the
 * fine print a 960 px frame has already lost: set symbols, collector numbers, a title's serifs.
 */
const DETAIL_QUALITY = 0.85;
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
 * The frame pump — one request in flight, every frame that arrives under it dropped.
 *
 * **The camera runs at 30–60 fps and the detector at roughly 9, and keeping the two apart is
 * the whole design.** Queuing the frames the detector cannot keep up with would make the
 * overlay drift further behind the longer a reader watched it, so a frame taken while a request
 * is outstanding is thrown away rather than sent. `inFlightRef` rather than a loop-local flag
 * because the guarantee has to survive a restart: toggling `live` off and on again while a
 * request is still outstanding would otherwise put a second one on the wire beside it.
 *
 * **`options` and `sendPx` are read through refs**, so dragging a slider re-renders the page
 * without tearing down the loop — the next frame simply goes out under the new numbers. That
 * is why the effect is keyed on `live` alone: a dependency on the options object would restart
 * the pump on every drag frame, and the restart is what a reader would see as a stall.
 *
 * **One frame in many also carries a detail image, and the session says which** (issue #708). A
 * verdict with `wants_detail` means the crate expects to read the title and collector bands on
 * the *next* frame, and those bands lose their fine print at the pump's 960 px. So the next grab
 * draws the video once at its own resolution and derives the small frame from that canvas —
 * never from the video a second time, which could be a newer frame than the one the detail
 * shows — and both go out in one request. Every other frame is the one JPEG it always was: the
 * full-size encode is the expensive half, and paying it nine times a second for a read that runs
 * on one frame in four would halve the rate the overlay tracks at.
 *
 * **And that grab waits `detailWaitMs` after the ask** (issue #741). The session asks as soon as
 * its hash tier is satisfied — in Fast, two frames that agree — and that tier works on a card
 * scaled down to a few hundred pixels, which a card still sliding into place or a lens still
 * refocusing after a hand crossed it satisfies as well as a sharp one. The fine print does not
 * survive either, so a grab on the very next iteration read a blurred collector line whenever
 * cards were laid down quickly. Three rules, each with its test:
 *
 * - **Nothing is sent during the wait.** The session reads its bands on the next trusted frame it
 *   gets, whatever that frame carries, so a plain frame sent to keep the overlay moving would
 *   *be* the read — at 960 px. The overlay holds its last quad for the length of the wait instead.
 * - **A run of asks waits once, on its first ask with the lock trusted.** A run is consecutive
 *   *verdicts* that ask, whatever each grab came to. Exact asks from the first frame with a quad
 *   in it until its resolve starts: a wait on each would stall the overlay through all of them,
 *   and a wait on the first would be spent before the lock had formed — on every stray quad, and
 *   two or three frames ahead of the first one a resolve can read. A verdict that does not ask
 *   ends the run, so the next ask waits again.
 * - **A camera that stops during the wait is not read after it**, and one that restarts during
 *   it starts a pump of its own that owes no wait.
 *
 * ⚠️ **None of it was measured on a camera** — `scannerOptions.ts`'s `DEFAULT_DETAIL_WAIT_MS`.
 */
export function useScanLoop({
  videoRef,
  live,
  options,
  sendPx,
  detailWaitMs,
  grabFrame = defaultGrabFrame,
  grabPair = defaultGrabPair,
  onDecision,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  live: boolean;
  options: ScannerOptions;
  sendPx: number;
  /**
   * The wait before a paired grab, in milliseconds. Read through a ref like `sendPx`, and
   * required like it: with a default here, a page that forgot to pass its slider's value would
   * compile, and the slider would move nothing.
   */
  detailWaitMs: number;
  grabFrame?: GrabFrame;
  /** The paired grab a frame after `wants_detail` uses. Injectable for {@link GrabFrame}'s reason. */
  grabPair?: GrabPair;
  /**
   * The session decided on a card — called once per new `decision_seq`, with the decision and
   * the number, and never for a repeat.
   *
   * **The first number after the camera starts is a baseline, not news.** A card frozen before a
   * view switch is still frozen when the camera comes back, and its decision rides every committed
   * frame; adding on that first frame would re-add the card the tray already holds. Read through a
   * ref like `options`, so a page passing a fresh closure each render does not restart the pump.
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
  // State rather than a ref, and the choice is not free: a ref would be the cheaper latch, but
  // `react-hooks/refs` forbids reading `.current` during render — and a value nothing may read
  // while drawing is a value no panel can draw. Both writes below land in the same batch as
  // `setVerdict`, so the frame that carried the read still costs exactly one commit.
  const [lastOcr, setLastOcr] = useState<ScannerOcr | null>(null);
  const [lastCollector, setLastCollector] = useState<ScannerCollector | null>(null);
  const [lastResolution, setLastResolution] = useState<ScannerResolution | null>(null);

  // **Every latch is emptied whenever the camera starts or stops.** A stream that has just
  // been opened must not show what the previous one read, and a reader who turned the camera
  // off is owed the same. React's own "adjusting state when a prop changes" pattern rather than
  // an effect: it is applied in this render instead of costing a second pass, and an effect
  // writing state is what `react-hooks/set-state-in-effect` refuses anyway.
  const [wasLive, setWasLive] = useState(live);
  if (wasLive !== live) {
    setWasLive(live);
    setLastOcr(null);
    setLastCollector(null);
    setLastResolution(null);
  }

  // Latched in a layout effect for `QrScanner`'s reason: the ref has to be current before the
  // next tick of a loop that mounted once and must not restart, and `useEffect` alone is not
  // guaranteed to run before that.
  const optionsRef = useRef(options);
  const sendPxRef = useRef(sendPx);
  const detailWaitRef = useRef(detailWaitMs);
  const grabRef = useRef(grabFrame);
  const grabPairRef = useRef(grabPair);
  const onDecisionRef = useRef(onDecision);
  useLayoutEffect(() => {
    optionsRef.current = options;
    sendPxRef.current = sendPx;
    detailWaitRef.current = detailWaitMs;
    grabRef.current = grabFrame;
    grabPairRef.current = grabPair;
    onDecisionRef.current = onDecision;
  });

  const inFlightRef = useRef(false);
  const tripsRef = useRef<number[]>([]);
  /**
   * The `decision_seq` of the last verdict this loop took, or `null` before the first one since the
   * camera started — which is what makes that first number a baseline. A ref and not state: nothing
   * draws it, and it has to be current for the very next answer rather than for the next render.
   */
  const lastSeqRef = useRef<number | null>(null);
  /**
   * Verdicts since the last decision, the one that carried it not counted — `Infinity` until the
   * camera's first, so a session's first card is never inside the gap. Counted from **every**
   * decision, a dropped one included: a session flapping between two answers every other frame
   * would otherwise get every second one through.
   */
  const sinceDecisionRef = useRef(Infinity);
  /**
   * The last verdict's `wants_detail`: whether the next frame goes out as a pair. A ref for
   * `lastSeqRef`'s reason — nothing draws it, and the pump reads it on its very next iteration.
   *
   * **Consumed by the grab that reads it, whatever that grab comes to.** A pair that fails — a
   * 2560 px canvas refused under memory pressure, a `toBlob` that answers nothing — leaves the
   * latch down, so the frame after it is an ordinary one and the scanner goes on tracking at
   * 960 px. A latch left up would retry the same failing grab on every iteration, and the pump
   * would send nothing at all: a lost read is worth less than a frozen overlay.
   */
  const wantsDetailRef = useRef(false);
  /**
   * Whether the run of asks the loop is in has had its wait. Lowered by a verdict that does not
   * ask, which is what ends a run.
   *
   * **Kept from the verdicts and not from what the last grab was.** A paired grab that fails
   * sends the next frame plain, and Exact asks again on that one — so "the last frame was not a
   * pair" waited afresh every other frame, for as long as the grab kept failing.
   */
  const waitedRef = useRef(false);
  const evidenceRef = useRef(0);
  const pendingFrameRef = useRef<Promise<void> | null>(null);
  const resetRef = useRef<Promise<void> | null>(null);

  const clearReads = useCallback(() => {
    // A grab or IPC answer already outstanding belongs to the evidence being discarded (#781).
    // Clearing state alone lets that answer put the old card straight back on the screen.
    evidenceRef.current += 1;
    setVerdict(null);
    setLastOcr(null);
    setLastCollector(null);
    setLastResolution(null);
    wantsDetailRef.current = false;
    waitedRef.current = false;
    sinceDecisionRef.current = Infinity;
  }, []);

  const reset = useCallback(() => {
    if (resetRef.current !== null) return resetRef.current;
    clearReads();
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
  }, [clearReads]);

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
    // A camera that has just started has seen no number yet; see `lastSeqRef`. Nor has it been
    // asked for a detail image — a latch left from the last stream belongs to a card it saw.
    lastSeqRef.current = null;
    sinceDecisionRef.current = Infinity;
    wantsDetailRef.current = false;
    waitedRef.current = false;

    async function pump() {
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
        let detail: Uint8Array | null = null;
        // Read and lowered in one step, before the grab can throw — see `wantsDetailRef`.
        const paired = wantsDetailRef.current;
        wantsDetailRef.current = false;
        try {
          if (paired) {
            const pair = await grabPairRef.current(video, sendPxRef.current, PUMP_QUALITY);
            bytes = pair?.frame ?? null;
            detail = pair?.detail ?? null;
          } else {
            bytes = await grabRef.current(video, sendPxRef.current, PUMP_QUALITY);
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
        // Whether this frame's answer earns the wait before the next grab — see `waitedRef`.
        let waits = false;
        const t0 = performance.now();
        try {
          // Two arities rather than a trailing `null`, so a frame with no detail is the very
          // call it was before the detail existed.
          const answer =
            detail === null
              ? await ipc.scannerFrame(bytes, optionsRef.current)
              : await ipc.scannerFrame(bytes, optionsRef.current, detail);
          const ms = performance.now() - t0;
          const trips = tripsRef.current;
          trips.push(ms);
          if (trips.length > WINDOW) trips.shift();
          if (stopped) return;
          if (evidence !== evidenceRef.current) continue;
          // `=== true` rather than the field itself: a far end that predates the field sends no
          // key, and `undefined` must mean "no" rather than whatever a truthiness test makes of it.
          const asks = answer.wants_detail === true;
          wantsDetailRef.current = asks;
          if (!asks) {
            waitedRef.current = false;
          } else if (!waitedRef.current && answer.lock?.phase === "locked") {
            waitedRef.current = true;
            waits = true;
          }
          setRoundTripMs(ms);
          setRate((1000 * trips.length) / trips.reduce((a, b) => a + b, 0));
          setVerdict(answer);
          // Latched only where there is something to latch: a frame the readers did not run
          // on carries `null`, and overwriting with it is the flicker this exists to stop.
          if (answer.ocr !== null) setLastOcr(answer.ocr);
          if (answer.collector !== null) setLastCollector(answer.collector);
          // A card that has left takes its resolve with it; one still in frame keeps the last.
          if (answer.quad === null) setLastResolution(null);
          else if (answer.resolution !== null) setLastResolution(answer.resolution);
          setError(null);
          // The decision edge. The ref moves on every verdict — a frame that repeats the number
          // is the frozen card still in front of the lens, and one with no decision is a card
          // nobody has settled on — and only a number that differs from the last one, on a frame
          // carrying the decision, is an add — unless it comes too soon after the last one to be
          // a second card (`DECISION_GAP_FRAMES`).
          const seenSeq = lastSeqRef.current;
          lastSeqRef.current = answer.decision_seq;
          sinceDecisionRef.current += 1;
          if (seenSeq !== null && answer.decision !== null && answer.decision_seq !== seenSeq) {
            const gap = sinceDecisionRef.current;
            sinceDecisionRef.current = 0;
            if (gap > DECISION_GAP_FRAMES) {
              onDecisionRef.current?.(answer.decision, answer.decision_seq);
            }
          }
        } catch (e) {
          // The loop does not stop on a failure. A missing bundle rejects every frame the same
          // way, and a reader who fixes it mid-session should see the scanner recover on its
          // own rather than have to leave the page and come back.
          if (!stopped && evidence === evidenceRef.current) setError(ipcError(e));
        } finally {
          inFlightRef.current = false;
          pendingFrameRef.current = null;
          drained();
        }

        // The wait before a paired grab — see the hook's own note. Here, at the tail of the
        // iteration that took the ask, rather than ahead of the grab: the loop's head then looks
        // at `stopped`, the video and its `readyState` afresh once the wait is over, where a
        // sleep in front of the grab would draw from a video it last checked before sleeping.
        if (waits && detailWaitRef.current > 0) {
          await sleep(detailWaitRef.current);
        }
      }
    }

    void pump();
    return () => {
      stopped = true;
    };
    // `videoRef` is stable by construction; everything else the loop reads is behind a ref.
  }, [live, videoRef]);

  return {
    verdict,
    lastOcr,
    lastCollector,
    lastResolution,
    roundTripMs,
    rate,
    error,
    grab,
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

/** The detail image's canvas — {@link scratch}'s reason, and never the same canvas as it. */
let detailScratch: HTMLCanvasElement | null = null;

/**
 * Video → the frame and its detail image, out of **one** draw of the video.
 *
 * The video is drawn once, at its own size capped at {@link DETAIL_LONG_EDGE}, and the frame is
 * drawn *from that canvas*: a second `drawImage(video)` reads whatever frame the element holds at
 * that moment, which at 30–60 fps can already be the next one, and the crate scales the quad it
 * found in the frame straight onto the detail image — so a pair from two video frames is a quad
 * laid over a card that has moved.
 *
 * Both encodes are started before either is awaited. `toBlob` takes its copy of the bitmap when it
 * is called, so neither result depends on what later draws do to the two shared canvases; the
 * capture button's grab can reuse {@link scratch} the moment this function has returned a promise.
 */
async function defaultGrabPair(
  video: HTMLVideoElement,
  longEdge: number,
  quality: number,
): Promise<GrabbedPair | null> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w === 0 || h === 0) return null;
  const big = (detailScratch ??= document.createElement("canvas"));
  const bigScale = Math.min(1, DETAIL_LONG_EDGE / Math.max(w, h));
  big.width = Math.round(w * bigScale);
  big.height = Math.round(h * bigScale);
  const bigCtx = big.getContext("2d");
  if (bigCtx === null) return null;
  bigCtx.drawImage(video, 0, 0, big.width, big.height);

  const small = (scratch ??= document.createElement("canvas"));
  const scale = Math.min(1, longEdge / Math.max(big.width, big.height));
  small.width = Math.round(big.width * scale);
  small.height = Math.round(big.height * scale);
  const ctx = small.getContext("2d");
  if (ctx === null) return null;
  ctx.drawImage(big, 0, 0, small.width, small.height);

  // A camera no larger than the frame has no finer print to give: the detail would be the frame
  // again at a higher quality, costing an encode and a body twice the size for nothing.
  const worthIt = big.width > small.width;
  const [frame, detail] = await Promise.all([
    jpegOf(small, quality),
    worthIt ? jpegOf(big, DETAIL_QUALITY) : Promise.resolve(null),
  ]);
  if (frame === null) return null;
  return { frame, detail };
}

/** A canvas's pixels as JPEG bytes, or `null` where the browser produced no blob. */
async function jpegOf(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array | null> {
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", quality),
  );
  if (blob === null) return null;
  return new Uint8Array(await blob.arrayBuffer());
}
