import { act, renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCamera } from "./useCamera";

function mediaDevices(getUserMedia: () => Promise<MediaStream>) {
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

describe("useCamera", () => {
  it("keys the refused camera on the DOMException name", async () => {
    mediaDevices(() => Promise.reject(new DOMException("denied", "NotAllowedError")));
    const ref = createRef<HTMLVideoElement>();
    const { result } = renderHook(() => useCamera(ref));
    await waitFor(() => expect(result.current.kind).toBe("error"));
    expect(result.current).toEqual({
      kind: "error",
      name: "NotAllowedError",
      message: "MTG Grimoire needs camera access to scan a card.",
    });
  });

  it("stops every track exactly once on unmount", async () => {
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }, { stop }] } as unknown as MediaStream;
    mediaDevices(() => Promise.resolve(stream));
    const video = document.createElement("video");
    Object.defineProperty(video, "play", { value: () => Promise.resolve() });
    Object.defineProperty(video, "videoWidth", { value: 1280 });
    Object.defineProperty(video, "videoHeight", { value: 720 });
    const ref = { current: video };
    const { result, unmount } = renderHook(() => useCamera(ref));
    await waitFor(() => expect(result.current.kind).toBe("live"));
    expect(result.current).toEqual({ kind: "live", width: 1280, height: 720 });
    unmount();
    expect(stop).toHaveBeenCalledTimes(2);
    unmount();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("stops each track once when the unmount and the cancelled start both reach for it", async () => {
    // The second `unmount()` above proves less than it looks: React does not re-run a cleanup it
    // has already run, so nothing there can catch a `stopAll` that stops a track twice. This is
    // the path that can — unmount while `play()` is still pending, which leaves the cleanup and
    // `start`'s own `cancelled` branch both calling it.
    const stop = vi.fn();
    const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
    mediaDevices(() => Promise.resolve(stream));
    const video = document.createElement("video");
    const playing = deferred<void>();
    Object.defineProperty(video, "play", { value: () => playing.promise });
    Object.defineProperty(video, "videoWidth", { value: 1280 });
    Object.defineProperty(video, "videoHeight", { value: 720 });
    const { unmount } = renderHook(() => useCamera({ current: video }));
    await act(async () => {});
    unmount();
    expect(stop).toHaveBeenCalledTimes(1);
    await act(async () => {
      playing.resolve();
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("asks for the environment camera at 1080p and no audio", async () => {
    const getUserMedia = vi.fn(() => Promise.reject(new DOMException("x", "NotFoundError")));
    mediaDevices(getUserMedia);
    renderHook(() => useCamera(createRef<HTMLVideoElement>()));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  });

  it("waits for loadedmetadata when play() resolves before the dimensions do", async () => {
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    mediaDevices(() => Promise.resolve(stream));
    const video = document.createElement("video");
    const playing = deferred<void>();
    Object.defineProperty(video, "play", { value: () => playing.promise });
    let w = 0;
    let h = 0;
    Object.defineProperty(video, "videoWidth", { get: () => w });
    Object.defineProperty(video, "videoHeight", { get: () => h });
    const { result } = renderHook(() => useCamera({ current: video }));
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
    await waitFor(() => expect(result.current).toEqual({ kind: "live", width: 640, height: 480 }));
  });

  it("swallows a rejected play() and still goes live", async () => {
    const stream = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
    mediaDevices(() => Promise.resolve(stream));
    const video = document.createElement("video");
    Object.defineProperty(video, "play", {
      value: () => Promise.reject(new DOMException("interrupted", "AbortError")),
    });
    Object.defineProperty(video, "videoWidth", { value: 1920 });
    Object.defineProperty(video, "videoHeight", { value: 1080 });
    const { result } = renderHook(() => useCamera({ current: video }));
    await waitFor(() => expect(result.current).toEqual({ kind: "live", width: 1920, height: 1080 }));
  });
});
