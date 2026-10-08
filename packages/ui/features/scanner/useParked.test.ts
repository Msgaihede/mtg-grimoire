import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PARK_GRACE_MS, useGrace, usePageHidden, usePageParked } from "./useParked";

/** The document, hidden or shown — an own property over the prototype's getter, and its event. */
function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  vi.useRealTimers();
  // Uncovers the prototype's getter again, so a later file reads the real answer.
  Reflect.deleteProperty(document, "visibilityState");
});

describe("usePageHidden", () => {
  it("follows the document into the background and back", () => {
    const { result } = renderHook(() => usePageHidden());
    expect(result.current).toBe(false);
    act(() => setVisibility("hidden"));
    expect(result.current).toBe(true);
    act(() => setVisibility("visible"));
    expect(result.current).toBe(false);
  });

  it("reads a page that mounted hidden as hidden", () => {
    setVisibility("hidden");
    const { result } = renderHook(() => usePageHidden());
    expect(result.current).toBe(true);
  });

  it("stops listening when it unmounts", () => {
    const removed = vi.spyOn(document, "removeEventListener");
    const { unmount } = renderHook(() => usePageHidden());
    unmount();
    expect(removed).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    removed.mockRestore();
  });
});

describe("useGrace", () => {
  it("pauses at once and releases only after the grace", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ away }) => useGrace(away), {
      initialProps: { away: false },
    });
    expect(result.current).toEqual({ paused: false, released: false });

    rerender({ away: true });
    expect(result.current).toEqual({ paused: true, released: false });
    act(() => vi.advanceTimersByTime(PARK_GRACE_MS - 1));
    expect(result.current.released).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toEqual({ paused: true, released: true });

    // Back in sight: both go in the render that sees it, with no frame still reading released.
    rerender({ away: false });
    expect(result.current).toEqual({ paused: false, released: false });
  });

  it("starts a whole grace again after a return, carrying nothing over", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ away }) => useGrace(away), {
      initialProps: { away: true },
    });
    act(() => vi.advanceTimersByTime(PARK_GRACE_MS / 2));
    rerender({ away: false });
    rerender({ away: true });
    act(() => vi.advanceTimersByTime(PARK_GRACE_MS / 2 + 1));
    expect(result.current).toEqual({ paused: true, released: false });
  });
});

describe("useGrace, for a view that can mount away", () => {
  it("starts released when it mounts away, and takes no grace to get there", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ away }) => useGrace(away, true), {
      initialProps: { away: true },
    });
    expect(result.current).toEqual({ paused: true, released: true });

    // In sight: nothing held back. Away again later is a view that was in sight — a whole grace.
    rerender({ away: false });
    expect(result.current).toEqual({ paused: false, released: false });
    rerender({ away: true });
    expect(result.current).toEqual({ paused: true, released: false });
    act(() => vi.advanceTimersByTime(PARK_GRACE_MS));
    expect(result.current).toEqual({ paused: true, released: true });
  });

  it("is an ordinary grace for a view that mounts in sight", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ away }) => useGrace(away, true), {
      initialProps: { away: false },
    });
    rerender({ away: true });
    expect(result.current).toEqual({ paused: true, released: false });
  });

  it("leaves a view that mounts away its grace unless asked — the desktop's window", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useGrace(true));
    expect(result.current).toEqual({ paused: true, released: false });
    act(() => vi.advanceTimersByTime(PARK_GRACE_MS));
    expect(result.current).toEqual({ paused: true, released: true });
  });
});

describe("usePageParked", () => {
  it("is released from its first render on a page that mounts hidden", () => {
    setVisibility("hidden");
    const { result } = renderHook(() => usePageParked());
    // No frame of it reads as a page that may open a camera.
    expect(result.current).toEqual({ paused: true, released: true });
    act(() => setVisibility("visible"));
    expect(result.current).toEqual({ paused: false, released: false });
  });

  it("is the grace over the document's own visibility", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePageParked());
    expect(result.current).toEqual({ paused: false, released: false });

    act(() => setVisibility("hidden"));
    expect(result.current).toEqual({ paused: true, released: false });
    act(() => vi.advanceTimersByTime(PARK_GRACE_MS));
    expect(result.current).toEqual({ paused: true, released: true });

    act(() => setVisibility("visible"));
    expect(result.current).toEqual({ paused: false, released: false });
  });
});
