import { useEffect, useState, type RefObject } from "react";
import { cameraSentence } from "./verdictText";

/**
 * Where this device's camera currently stands. `live` carries the stream's own pixel size, and
 * the id of the camera that actually opened — which is not always the one asked for (see
 * {@link useCamera}'s fallback).
 */
export type CameraState =
  | { kind: "starting" }
  | { kind: "live"; width: number; height: number; deviceId: string | null }
  | { kind: "error"; name: string; message: string };

/** One camera a reader can pick, named for the picker. */
export interface CameraDevice {
  deviceId: string;
  label: string;
}

const STARTING: CameraState = { kind: "starting" };

/**
 * The two rejections that mean *that camera is not here* rather than *no camera will do*.
 * `OverconstrainedError` is the spec's answer to an `exact` id nothing matches; `NotFoundError` is
 * taken too, because an engine may report a device that has gone that way instead. Neither has
 * been driven in WebView2 with a camera pulled out. Anything else — a refused permission above
 * all — would fail the default request identically, so it is reported as it stands.
 */
const GONE = new Set(["OverconstrainedError", "NotFoundError"]);

/** `OverconstrainedError` is not a `DOMException` in every engine, so the name is read off the
 *  object rather than off a class. */
function errorName(err: unknown): string {
  return typeof err === "object" && err !== null && "name" in err && typeof err.name === "string"
    ? err.name
    : "";
}

/**
 * What `getUserMedia` is asked for. `null` is the debug page's request verbatim
 * (`crates/card-scanner/src/bin/live.html`): `facingMode: { ideal: "environment" }` at an *ideal*
 * 1080p, so a webcam that has no rear lens and no 1080p mode still opens rather than failing the
 * whole request. A named camera swaps the facing for its `exact` id and keeps the ideal size.
 * `audio: false` is not decoration — asking for a track this app never plays would light a
 * microphone indicator.
 */
function request(deviceId: string | null): MediaStreamConstraints {
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  return {
    video:
      deviceId === null
        ? { facingMode: { ideal: "environment" }, ...size }
        : { deviceId: { exact: deviceId }, ...size },
    audio: false,
  };
}

/**
 * The id of the camera a stream came from, or `null` when the stream will not say. The optional
 * calls are for stand-ins rather than for browsers — a test's or a story's stream that implements
 * `getTracks` alone reads as "not known", which is the answer the type already allows.
 */
function openedId(stream: MediaStream): string | null {
  return stream.getVideoTracks?.()[0]?.getSettings?.().deviceId ?? null;
}

/**
 * A camera into a `<video>` — `QrScanner.tsx`'s effect, with the scanner's sentences.
 *
 * **`deviceId` has three values and each means something different.** A string is the reader's
 * stored choice, asked for by `exact` id. `null` is "no choice", which asks for the default request
 * above. `undefined` is "the choice is not known yet" and opens **nothing**: the scanner's prefs
 * load asynchronously, and opening the default on mount only to reopen the stored camera a moment
 * later is two `getUserMedia` calls, a flicker, and on some platforms a second permission prompt.
 *
 * **A stored camera that has gone is not an error.** If the `exact` request fails because nothing
 * answers to that id — the webcam was unplugged, or it is another machine's id — the default
 * request goes out instead, and `live.deviceId` says which camera actually opened. The stored
 * choice is the page's and is left alone, so plugging the camera back in and reopening the view
 * finds it again.
 *
 * **One `stopAll`, and every exit path goes through it** — a cancelled start, a missing video
 * element, and the cleanup. It nulls `stream` as it goes, so calling it twice stops each track
 * once, which is the whole of what "exactly once" costs. A camera left running is a lit
 * indicator on the reader's machine after they have moved on — and on a switch, a webcam some
 * drivers will not hand to a second stream while the first still holds it.
 *
 * ⚠️ **`NotSupportedError` from `getUserMedia` here does not mean the API is missing.** In the
 * Tauri WebView2 it is an unhandled `PermissionRequested`, which `src-tauri/src/camera.rs`
 * answers; `QrScanner.tsx` carries the full measurement.
 */
export function useCamera(
  videoRef: RefObject<HTMLVideoElement | null>,
  deviceId: string | null | undefined,
): CameraState {
  const [state, setState] = useState<CameraState>(STARTING);
  // The camera the state above is about. A switch puts the state back to `starting` during the
  // render that asks for it — React's own answer to state that follows a prop — so no frame reports
  // the old camera as live after its tracks were stopped, and no effect has to notice the change.
  const [asked, setAsked] = useState(deviceId);
  if (asked !== deviceId) {
    setAsked(deviceId);
    setState(STARTING);
  }

  useEffect(() => {
    if (deviceId === undefined) return;
    const wanted = deviceId;
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

    /** The asked-for camera, and the default in its place when that one is not there. */
    async function open(): Promise<MediaStream> {
      if (wanted === null) return navigator.mediaDevices.getUserMedia(request(null));
      try {
        return await navigator.mediaDevices.getUserMedia(request(wanted));
      } catch (err) {
        if (cancelled || !GONE.has(errorName(err))) throw err;
        return navigator.mediaDevices.getUserMedia(request(null));
      }
    }

    async function start() {
      try {
        const media = await open();
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
        const live = (): CameraState => ({
          kind: "live",
          width: target.videoWidth,
          height: target.videoHeight,
          deviceId: openedId(media),
        });
        if (target.videoWidth > 0 && target.videoHeight > 0) {
          setState(live());
          return;
        }
        onMeta = () => {
          if (cancelled) return;
          setState(live());
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
    // A ref object is stable by construction, so this re-runs on `deviceId` alone — and that is
    // deliberate: a re-run is a camera switch, whose cleanup stops every track of the old stream
    // before the new request goes out. It is also the one thing that may re-ask for permission,
    // which is why the page holds this at `undefined` until the stored choice is known rather
    // than letting it run once on a guess.
  }, [videoRef, deviceId]);

  return state;
}

/**
 * The cameras this machine has, for the picker — `enumerateDevices()`'s `videoinput`s.
 *
 * **A browser names no camera until one has been opened.** Before the permission lands every label
 * is empty (and in some engines every id too), so an unnamed camera is called `Camera 1`,
 * `Camera 2`… by its position, and the list is read again whenever `refreshKey` changes — the page
 * passes the live camera's id, which turns up exactly when the permission has, so the real names
 * replace the numbers without anybody reopening the view. A camera plugged in or pulled out is the
 * `devicechange` event, and that re-reads too.
 *
 * **A device with no id is left out**: it cannot be asked for by `exact` id, so offering it would be
 * a row whose press opens the default and stores an id that means nothing.
 *
 * `[]` wherever there is no `enumerateDevices` to ask — jsdom, and the workbench's stand-in — and
 * while the first answer is in flight. A failed read keeps the last list rather than emptying the
 * picker under the reader.
 */
export function useCameraDevices(refreshKey: unknown): CameraDevice[] {
  const [devices, setDevices] = useState<CameraDevice[]>([]);

  useEffect(() => {
    // Typed as always there, and absent in jsdom and on an insecure origin alike.
    const media: MediaDevices | undefined = navigator.mediaDevices;
    if (typeof media?.enumerateDevices !== "function") return;
    let gone = false;

    const read = () => {
      media.enumerateDevices().then(
        (all) => {
          if (!gone) setDevices(camerasOf(all));
        },
        () => {
          // Nothing to say: the list on screen is the best answer there is.
        },
      );
    };

    read();
    media.addEventListener?.("devicechange", read);
    return () => {
      gone = true;
      media.removeEventListener?.("devicechange", read);
    };
  }, [refreshKey]);

  return devices;
}

/** The `videoinput`s with an id, each named — its own label, or its position when it has none. */
function camerasOf(all: readonly MediaDeviceInfo[]): CameraDevice[] {
  return all
    .filter((device) => device.kind === "videoinput" && device.deviceId !== "")
    .map((device, i) => ({ deviceId: device.deviceId, label: device.label || `Camera ${i + 1}` }));
}
