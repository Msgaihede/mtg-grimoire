import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/window", () => import("../../../.storybook/fake/window"));

import { resetWindow, setMinimized } from "../../../.storybook/fake/window";
import { PARK_GRACE_MS, useWindowMinimized, useWindowParked } from "./useWindowParked";

beforeEach(() => resetWindow());
afterEach(() => {
  vi.useRealTimers();
  resetWindow();
});

/** Lets the subscriptions land: each is a promise, like the real window's. */
async function subscribed() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useWindowMinimized", () => {
  it("follows the window to the taskbar and back", async () => {
    const { result } = renderHook(() => useWindowMinimized());
    await subscribed();
    expect(result.current).toBe(false);

    act(() => setMinimized(true));
    await waitFor(() => expect(result.current).toBe(true));
    act(() => setMinimized(false));
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("reads a window that mounted minimized as minimized", async () => {
    setMinimized(true);
    const { result } = renderHook(() => useWindowMinimized());
    await waitFor(() => expect(result.current).toBe(true));
  });

  /**
   * WebView2 says `visible` for a minimized page, but an engine that does say `hidden` is
   * believed: the two answers are ORed.
   */
  it("takes a hidden document as minimized too", async () => {
    const { result } = renderHook(() => useWindowMinimized());
    await subscribed();
    // An own property over the prototype's getter, deleted afterwards to uncover it again.
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(result.current).toBe(true);
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });
});

describe("useWindowParked", () => {
  it("pauses on the minimize and releases only after the grace", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWindowParked());
    await subscribed();
    expect(result.current).toEqual({ paused: false, released: false });

    act(() => setMinimized(true));
    await subscribed();
    expect(result.current).toEqual({ paused: true, released: false });

    act(() => vi.advanceTimersByTime(PARK_GRACE_MS - 1));
    expect(result.current.released).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toEqual({ paused: true, released: true });

    act(() => setMinimized(false));
    await subscribed();
    expect(result.current).toEqual({ paused: false, released: false });
  });

  it("does not release a window restored inside the grace", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useWindowParked());
    await subscribed();

    act(() => setMinimized(true));
    await subscribed();
    act(() => vi.advanceTimersByTime(PARK_GRACE_MS / 2));
    act(() => setMinimized(false));
    await subscribed();
    // A minimize after the restore starts a whole grace of its own; the half spent before it is
    // not carried over.
    act(() => setMinimized(true));
    await subscribed();
    act(() => vi.advanceTimersByTime(PARK_GRACE_MS / 2 + 1));
    expect(result.current).toEqual({ paused: true, released: false });
  });
});
