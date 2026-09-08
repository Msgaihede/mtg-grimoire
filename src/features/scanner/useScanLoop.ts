import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ipc, ipcError } from "@/lib/ipc";
import type { ScannerCollector, ScannerOcr, ScannerOptions, ScannerVerdict } from "./types";

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
  roundTripMs: number | null;
  /** Frames per second over the last twenty round trips. `null` until the first answers. */
  rate: number | null;
  error: string | null;
  /** One frame out of the video, for the capture button. `Infinity` means "do not downscale". */
  grab: (longEdge: number, quality: number) => Promise<Uint8Array | null>;
  /**
   * Throw both kept reads away.
   *
   * The Reset press's other half: `scanner_reset` drops the tracker's evidence in the crate,
   * and the two latches above are evidence this side is holding. Leaving them would show a
   * title the reader has just asked the scanner to forget.
   */
  clearReads: () => void;
}

/** How a frame becomes JPEG bytes. Injectable because jsdom has no canvas pixels to draw on. */
export type GrabFrame = (
  video: HTMLVideoElement,
  longEdge: number,
  quality: number,
) => Promise<Uint8Array | null>;

/** The quality the pump sends at. The capture button uses 0.92 — see {@link ScanLoop.grab}. */
const PUMP_QUALITY = 0.72;
/** The idle wait between two looks at a video that has nothing new, matching the debug page. */
const IDLE_MS = 16;
/** How many round trips the rate averages over. */
const WINDOW = 20;

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
 */
export function useScanLoop({
  videoRef,
  live,
  options,
  sendPx,
  grabFrame = defaultGrabFrame,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  live: boolean;
  options: ScannerOptions;
  sendPx: number;
  grabFrame?: GrabFrame;
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

  // **Both latches are emptied whenever the camera starts or stops.** A stream that has just
  // been opened must not show what the previous one read, and a reader who turned the camera
  // off is owed the same. React's own "adjusting state when a prop changes" pattern rather than
  // an effect: it is applied in this render instead of costing a second pass, and an effect
  // writing state is what `react-hooks/set-state-in-effect` refuses anyway.
  const [wasLive, setWasLive] = useState(live);
  if (wasLive !== live) {
    setWasLive(live);
    setLastOcr(null);
    setLastCollector(null);
  }

  const clearReads = useCallback(() => {
    setLastOcr(null);
    setLastCollector(null);
  }, []);

  // Latched in a layout effect for `QrScanner`'s reason: the ref has to be current before the
  // next tick of a loop that mounted once and must not restart, and `useEffect` alone is not
  // guaranteed to run before that.
  const optionsRef = useRef(options);
  const sendPxRef = useRef(sendPx);
  const grabRef = useRef(grabFrame);
  useLayoutEffect(() => {
    optionsRef.current = options;
    sendPxRef.current = sendPx;
    grabRef.current = grabFrame;
  });

  const inFlightRef = useRef(false);
  const tripsRef = useRef<number[]>([]);

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

    async function pump() {
      while (!stopped) {
        const video = videoRef.current;
        // `readyState < 2` is `HAVE_CURRENT_DATA` unmet — there is no frame to draw yet.
        if (video === null || inFlightRef.current || video.readyState < 2) {
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
        try {
          bytes = await grabRef.current(video, sendPxRef.current, PUMP_QUALITY);
        } catch (e) {
          if (!stopped) setError(ipcError(e));
          await sleep(IDLE_MS);
          continue;
        }
        if (bytes === null) {
          await sleep(IDLE_MS);
          continue;
        }

        inFlightRef.current = true;
        const t0 = performance.now();
        try {
          const answer = await ipc.scannerFrame(bytes, optionsRef.current);
          const ms = performance.now() - t0;
          const trips = tripsRef.current;
          trips.push(ms);
          if (trips.length > WINDOW) trips.shift();
          if (stopped) return;
          setRoundTripMs(ms);
          setRate((1000 * trips.length) / trips.reduce((a, b) => a + b, 0));
          setVerdict(answer);
          // Latched only where there is something to latch: a frame the readers did not run
          // on carries `null`, and overwriting with it is the flicker this exists to stop.
          if (answer.ocr !== null) setLastOcr(answer.ocr);
          if (answer.collector !== null) setLastCollector(answer.collector);
          setError(null);
        } catch (e) {
          // The loop does not stop on a failure. A missing bundle rejects every frame the same
          // way, and a reader who fixes it mid-session should see the scanner recover on its
          // own rather than have to leave the page and come back.
          if (!stopped) setError(ipcError(e));
        } finally {
          inFlightRef.current = false;
        }
      }
    }

    void pump();
    return () => {
      stopped = true;
    };
    // `videoRef` is stable by construction; everything else the loop reads is behind a ref.
  }, [live, videoRef]);

  return { verdict, lastOcr, lastCollector, roundTripMs, rate, error, grab, clearReads };
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
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", quality),
  );
  if (blob === null) return null;
  return new Uint8Array(await blob.arrayBuffer());
}
