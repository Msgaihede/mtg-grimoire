import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PHONE_PX } from "@/lib/viewports";
import { useNarrowWindow } from "@/lib/useNarrowWindow";

/** jsdom's `matchMedia` is a stub that never matches, so the query is driven by hand. */
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches,
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return listeners;
}

describe("useNarrowWindow", () => {
  it("asks about the phone width and nothing else", () => {
    let asked = "";
    vi.stubGlobal("matchMedia", (query: string) => {
      asked = query;
      return {
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      };
    });
    renderHook(() => useNarrowWindow());
    // The number comes from `viewports.ts` rather than being typed here, so a change there
    // moves the branch with it.
    expect(asked).toContain(String(PHONE_PX));
    vi.unstubAllGlobals();
  });

  it("answers what the query says", () => {
    stubMatchMedia(true);
    expect(renderHook(() => useNarrowWindow()).result.current).toBe(true);
    stubMatchMedia(false);
    expect(renderHook(() => useNarrowWindow()).result.current).toBe(false);
    vi.unstubAllGlobals();
  });

  /**
   * A window resized past the threshold has to reach the shell, because the rail and the bar are
   * two different sets of buttons — a stale answer is navigation that no longer fits the window
   * it is drawn in. What this pins is that the hook *subscribes*: a `useSyncExternalStore` whose
   * `subscribe` never registered would still pass both cases above, since each of those reads
   * once and never asks again.
   */
  it("re-reads when the window crosses the threshold", () => {
    let matches = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return matches;
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }));

    const { result } = renderHook(() => useNarrowWindow());
    expect(result.current).toBe(false);

    act(() => {
      matches = true;
      for (const fn of listeners) fn();
    });

    expect(result.current).toBe(true);
    vi.unstubAllGlobals();
  });
});
