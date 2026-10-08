import { act, renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCamera, useCameraDevices } from "./useCamera";

function mediaDevices(getUserMedia: (constraints?: MediaStreamConstraints) => Promise<MediaStream>) {
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
}
afterEach(() => {
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A stream whose tracks are `stop`s and whose video track says it came from `deviceId`. */
function stream(stop: () => void, deviceId = "cam-default", tracks = 1): MediaStream {
  return {
    getTracks: () => Array.from({ length: tracks }, () => ({ stop })),
    getVideoTracks: () => [{ getSettings: () => ({ deviceId }) }],
  } as unknown as MediaStream;
}

/** A `<video>` that plays at once and already knows its size. */
function readyVideo(width = 1280, height = 720): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "play", { value: () => Promise.resolve() });
  Object.defineProperty(video, "videoWidth", { value: width });
  Object.defineProperty(video, "videoHeight", { value: height });
  return video;
}

/** The request `null` sends — the debug page's, verbatim. */
const DEFAULT_REQUEST = {
  video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  audio: false,
};

/**
 * **Every ref here is built once, outside the hook's callback.** `videoRef` is one of the effect's
 * dependencies, so a `createRef()` inside `renderHook(() => …)` is a new object on every render —
 * each state change then re-runs the effect and asks for the camera again, and a call count means
 * nothing.
 */
describe("useCamera", () => {
  it("keys the refused camera on the DOMException name", async () => {
    mediaDevices(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    const ref = createRef<HTMLVideoElement>();
    const { result } = renderHook(() => useCamera(ref, null));
    await waitFor(() => expect(result.current.kind).toBe("error"));
    expect(result.current).toEqual({
      kind: "error",
      name: "NotAllowedError",
      message: "MTG Grimoire needs camera access to scan a card.",
    });
  });

  it("stops every track exactly once on unmount", async () => {
    const stop = vi.fn();
    mediaDevices(() => Promise.resolve(stream(stop, "cam-a", 2)));
    const ref = { current: readyVideo() };
    const { result, unmount } = renderHook(() => useCamera(ref, null));
    await waitFor(() => expect(result.current.kind).toBe("live"));
    unmount();
    expect(stop).toHaveBeenCalledTimes(2);
    unmount();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("reports the camera that opened, read off the video track's own settings", async () => {
    mediaDevices(() => Promise.resolve(stream(vi.fn(), "cam-brio")));
    const ref = { current: readyVideo(1280, 720) };
    const { result } = renderHook(() => useCamera(ref, null));
    await waitFor(() =>
      expect(result.current).toEqual({ kind: "live", width: 1280, height: 720, deviceId: "cam-brio" }),
    );
  });

  it("stops each track once when the unmount and the cancelled start both reach for it", async () => {
    // The second `unmount()` above proves less than it looks: React does not re-run a cleanup it
    // has already run, so nothing there can catch a `stopAll` that stops a track twice. This is
    // the path that can — unmount while `play()` is still pending, which leaves the cleanup and
    // `start`'s own `cancelled` branch both calling it.
    const stop = vi.fn();
    mediaDevices(() => Promise.resolve(stream(stop)));
    const video = document.createElement("video");
    const playing = deferred<void>();
    Object.defineProperty(video, "play", { value: () => playing.promise });
    Object.defineProperty(video, "videoWidth", { value: 1280 });
    Object.defineProperty(video, "videoHeight", { value: 720 });
    const ref = { current: video };
    const { unmount } = renderHook(() => useCamera(ref, null));
    await act(async () => {});
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
    await act(async () => {
      playing.resolve();
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("asks for the environment camera at 1080p and no audio when no camera is chosen", async () => {
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException("x", "NotFoundError")));
    mediaDevices(getUserMedia);
    const ref = createRef<HTMLVideoElement>();
    renderHook(() => useCamera(ref, null));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith(DEFAULT_REQUEST);
  });

  it("asks for a chosen camera by its exact id, at the same ideal size", async () => {
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => {}));
    mediaDevices(getUserMedia);
    const ref = createRef<HTMLVideoElement>();
    renderHook(() => useCamera(ref, "cam-brio"));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { deviceId: { exact: "cam-brio" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  });

  it("opens the default in place of a chosen camera that is not there, and says which opened", async () => {
    const getUserMedia = vi
      .fn<(c?: MediaStreamConstraints) => Promise<MediaStream>>()
      .mockRejectedValueOnce(new DOMException("gone", "OverconstrainedError"))
      .mockResolvedValueOnce(stream(vi.fn(), "cam-integrated"));
    mediaDevices(getUserMedia);
    const ref = { current: readyVideo(1280, 720) };
    const { result } = renderHook(() => useCamera(ref, "cam-unplugged"));
    await waitFor(() =>
      expect(result.current).toEqual({
        kind: "live",
        width: 1280,
        height: 720,
        deviceId: "cam-integrated",
      }),
    );
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia).toHaveBeenLastCalledWith(DEFAULT_REQUEST);
  });

  it("does not fall back past a refused permission", async () => {
    // Every camera would be refused the same way, so a second request is a second prompt for
    // nothing — the refusal is the answer.
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    mediaDevices(getUserMedia);
    const ref = createRef<HTMLVideoElement>();
    const { result } = renderHook(() => useCamera(ref, "cam-brio"));
    await waitFor(() => expect(result.current.kind).toBe("error"));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("opens nothing while the choice is unknown, and one camera once it is", async () => {
    const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => {}));
    mediaDevices(getUserMedia);
    const ref = createRef<HTMLVideoElement>();
    const initialProps: { id: string | null | undefined } = { id: undefined };
    const { result, rerender } = renderHook(({ id }) => useCamera(ref, id), { initialProps });
    await act(async () => {});
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(result.current).toEqual({ kind: "starting" });

    rerender({ id: "cam-brio" });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("stops the old camera's tracks before asking for the new one, and starts over", async () => {
    const stopA = vi.fn();
    const stopB = vi.fn();
    const second = deferred<MediaStream>();
    const getUserMedia = vi.fn((c?: MediaStreamConstraints) => {
      const video = c?.video as MediaTrackConstraints;
      if ((video.deviceId as ConstrainDOMStringParameters).exact === "cam-a") {
        return Promise.resolve(stream(stopA, "cam-a"));
      }
      // The old stream has to be down by the time the new one is asked for — a webcam held by
      // one stream cannot always be opened by a second.
      expect(stopA).toHaveBeenCalledTimes(1);
      return second.promise;
    });
    mediaDevices(getUserMedia);
    const ref = { current: readyVideo() };
    const { result, rerender } = renderHook(({ id }: { id: string }) => useCamera(ref, id), {
      initialProps: { id: "cam-a" },
    });
    await waitFor(() => expect(result.current).toMatchObject({ kind: "live", deviceId: "cam-a" }));

    rerender({ id: "cam-b" });
    expect(stopA).toHaveBeenCalledTimes(1);
    // Not the old camera, still reported live after its tracks were stopped.
    expect(result.current).toEqual({ kind: "starting" });
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));

    await act(async () => {
      second.resolve(stream(stopB, "cam-b"));
    });
    await waitFor(() => expect(result.current).toMatchObject({ kind: "live", deviceId: "cam-b" }));
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).not.toHaveBeenCalled();
  });

  it("waits for loadedmetadata when play() resolves before the dimensions do", async () => {
    mediaDevices(() => Promise.resolve(stream(vi.fn(), "cam-a")));
    const video = document.createElement("video");
    const playing = deferred<void>();
    Object.defineProperty(video, "play", { value: () => playing.promise });
    let w = 0;
    let h = 0;
    Object.defineProperty(video, "videoWidth", { get: () => w });
    Object.defineProperty(video, "videoHeight", { get: () => h });
    const ref = { current: video };
    const { result } = renderHook(() => useCamera(ref, null));
    // Resolving `play()` inside `act` puts the hook past its `await` in this same drain, so the
    // assertion below is about a settled state rather than one the hook has not reached yet —
    // which is what an empty `act()` here would have been.
    await act(async () => {
      playing.resolve();
    });
    expect(result.current.kind).toBe("starting");
    w = 640;
    h = 480;
    video.dispatchEvent(new Event("loadedmetadata"));
    await waitFor(() =>
      expect(result.current).toEqual({ kind: "live", width: 640, height: 480, deviceId: "cam-a" }),
    );
  });

  it("swallows a rejected play() and still goes live", async () => {
    mediaDevices(() => Promise.resolve(stream(vi.fn(), "cam-a")));
    const video = document.createElement("video");
    Object.defineProperty(video, "play", {
      value: () => Promise.reject(new DOMException("interrupted", "AbortError")),
    });
    Object.defineProperty(video, "videoWidth", { value: 1920 });
    Object.defineProperty(video, "videoHeight", { value: 1080 });
    const ref = { current: video };
    const { result } = renderHook(() => useCamera(ref, null));
    await waitFor(() =>
      expect(result.current).toEqual({ kind: "live", width: 1920, height: 1080, deviceId: "cam-a" }),
    );
  });
});

/** One `enumerateDevices` row. */
function device(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: "" } as unknown as MediaDeviceInfo;
}

/** A `mediaDevices` that can be enumerated and can fire `devicechange`, and nothing else. */
function enumerable(enumerateDevices: () => Promise<MediaDeviceInfo[]>): EventTarget {
  const target = Object.assign(new EventTarget(), { enumerateDevices });
  Object.defineProperty(navigator, "mediaDevices", { value: target, configurable: true });
  return target;
}

describe("useCameraDevices", () => {
  it("lists the video inputs, numbering the ones the browser has not named yet", async () => {
    enumerable(() =>
      Promise.resolve([
        device("videoinput", "a", ""),
        device("audioinput", "mic", "Microphone"),
        device("videoinput", "b", "Logitech BRIO"),
        device("videoinput", "c", ""),
      ]),
    );
    const { result } = renderHook(() => useCameraDevices(null));
    await waitFor(() =>
      expect(result.current).toEqual([
        { deviceId: "a", label: "Camera 1" },
        { deviceId: "b", label: "Logitech BRIO" },
        { deviceId: "c", label: "Camera 3" },
      ]),
    );
  });

  it("leaves out a camera with no id, which nothing could ask for", async () => {
    enumerable(() => Promise.resolve([device("videoinput", "", ""), device("videoinput", "b", "BRIO")]));
    const { result } = renderHook(() => useCameraDevices(null));
    await waitFor(() => expect(result.current).toEqual([{ deviceId: "b", label: "BRIO" }]));
  });

  it("reads the list again on devicechange, and stops listening once unmounted", async () => {
    const enumerate = vi
      .fn<() => Promise<MediaDeviceInfo[]>>()
      .mockResolvedValueOnce([device("videoinput", "a", "Integrated Camera")])
      .mockResolvedValue([
        device("videoinput", "a", "Integrated Camera"),
        device("videoinput", "b", "Logitech BRIO"),
      ]);
    const target = enumerable(enumerate);
    const { result, unmount } = renderHook(() => useCameraDevices(null));
    await waitFor(() => expect(result.current).toHaveLength(1));

    await act(async () => {
      target.dispatchEvent(new Event("devicechange"));
    });
    await waitFor(() => expect(result.current.map((c) => c.label)).toEqual(["Integrated Camera", "Logitech BRIO"]));

    unmount();
    target.dispatchEvent(new Event("devicechange"));
    expect(enumerate).toHaveBeenCalledTimes(2);
  });

  it("reads the list again when the refresh key moves — the names a permission brings", async () => {
    const enumerate = vi
      .fn<() => Promise<MediaDeviceInfo[]>>()
      .mockResolvedValueOnce([device("videoinput", "a", "")])
      .mockResolvedValue([device("videoinput", "a", "Logitech BRIO")]);
    enumerable(enumerate);
    const initialProps: { key: string | null } = { key: null };
    const { result, rerender } = renderHook(({ key }) => useCameraDevices(key), { initialProps });
    await waitFor(() => expect(result.current).toEqual([{ deviceId: "a", label: "Camera 1" }]));

    rerender({ key: "a" });
    await waitFor(() => expect(result.current).toEqual([{ deviceId: "a", label: "Logitech BRIO" }]));
    expect(enumerate).toHaveBeenCalledTimes(2);
  });

  it("answers no cameras where there is nothing to enumerate", async () => {
    // `afterEach` leaves `mediaDevices` undefined, which is jsdom's own state and an insecure
    // origin's.
    const { result } = renderHook(() => useCameraDevices(null));
    await act(async () => {});
    expect(result.current).toEqual([]);
  });
});
