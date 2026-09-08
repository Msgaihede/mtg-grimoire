import { useEffect, useState, type RefObject } from "react";
import { cameraSentence } from "./verdictText";

/** Where this device's camera currently stands. `live` carries the stream's own pixel size. */
export type CameraState =
  | { kind: "starting" }
  | { kind: "live"; width: number; height: number }
  | { kind: "error"; name: string; message: string };

/**
 * The rear camera into a `<video>` — `QrScanner.tsx`'s effect, with the scanner's sentences.
 *
 * The constraints are the debug page's verbatim (`crates/card-scanner/src/bin/live.html`):
 * `facingMode: { ideal: "environment" }` at an *ideal* 1080p, so a webcam that has no rear
 * lens and no 1080p mode still opens rather than failing the whole request. `audio: false` is
 * not decoration — asking for a track this app never plays would light a microphone indicator.
 *
 * **One `stopAll`, and every exit path goes through it** — a cancelled start, a missing video
 * element, and the cleanup. It nulls `stream` as it goes, so calling it twice stops each track
 * once, which is the whole of what "exactly once" costs. A camera left running is a lit
 * indicator on the reader's machine after they have moved on.
 *
 * ⚠️ **`NotSupportedError` from `getUserMedia` here does not mean the API is missing.** In the
 * Tauri WebView2 it is an unhandled `PermissionRequested`, which `src-tauri/src/camera.rs`
 * answers; `QrScanner.tsx` carries the full measurement.
 */
export function useCamera(videoRef: RefObject<HTMLVideoElement | null>): CameraState {
  const [state, setState] = useState<CameraState>({ kind: "starting" });

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let video: HTMLVideoElement | null = null;
    let onMeta: (() => void) | null = null;

    function stopAll() {
      if (video !== null && onMeta !== null) {
        video.removeEventListener("loadedmetadata", onMeta);
        onMeta = null;
      }
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    }

    async function start() {
      try {
        const media = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = media;
        video = videoRef.current;
        if (video === null) {
          stopAll();
          return;
        }
        video.srcObject = media;
        try {
          await video.play();
        } catch {
          // Some browsers reject an explicit `play()` on a video that is about to play anyway —
          // an `AbortError` from one request interrupting another is the common case. The
          // dimensions below are the real signal, so a rejection here is not fatal on its own.
        }
        if (cancelled) {
          stopAll();
          return;
        }

        // `play()` resolving does not guarantee the metadata has landed: both dimensions read 0
        // until it does, and a `live` state carrying 0×0 would size the overlay canvas to
        // nothing. So take them when they are there, and wait for the event when they are not.
        const target = video;
        if (target.videoWidth > 0 && target.videoHeight > 0) {
          setState({ kind: "live", width: target.videoWidth, height: target.videoHeight });
          return;
        }
        onMeta = () => {
          if (cancelled) return;
          setState({ kind: "live", width: target.videoWidth, height: target.videoHeight });
        };
        target.addEventListener("loadedmetadata", onMeta);
      } catch (err) {
        if (!cancelled) setState({ kind: "error", ...cameraSentence(err) });
      }
    }

    void start();

    return () => {
      cancelled = true;
      stopAll();
    };
    // `videoRef` alone: a ref object is stable by construction, so this reads as an empty list
    // at runtime. Re-running would re-ask for the camera, which is a second permission prompt
    // on some platforms.
  }, [videoRef]);

  return state;
}
