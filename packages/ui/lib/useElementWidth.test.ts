import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useElementWidth } from "./useElementWidth";

/**
 * **jsdom lays nothing out and its observer never reports**, so what is asserted here is the
 * wiring: which element is observed, that the width is whatever the observer last said, that `0`
 * stands until it says anything, and that the observer is given back when the element goes. The
 * widths are stubbed by hand and are the hook's own plumbing being pinned, never a claim about
 * what a browser would have measured.
 */
interface Watcher {
  callback: ResizeObserverCallback;
  observed: Element[];
  disconnected: boolean;
}
let watchers: Watcher[] = [];

beforeEach(() => {
  watchers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly self: Watcher;
      constructor(callback: ResizeObserverCallback) {
        this.self = { callback, observed: [], disconnected: false };
        watchers.push(this.self);
      }
      observe(el: Element) {
        this.self.observed.push(el);
      }
      unobserve() {}
      disconnect() {
        this.self.disconnected = true;
      }
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

/** Report a content box `width` px wide to one observer. */
function report(watcher: Watcher, width: number): void {
  act(() => {
    watcher.callback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
  });
}

describe("useElementWidth", () => {
  it("answers 0 until the observer reports, and observes nothing before an element arrives", () => {
    const { result } = renderHook(() => useElementWidth<HTMLDivElement>());

    expect(result.current[1]).toBe(0);
    expect(watchers).toHaveLength(0);
  });

  it("observes the element it is attached to and answers what the observer last said", () => {
    const { result } = renderHook(() => useElementWidth<HTMLDivElement>());
    const el = document.createElement("div");

    act(() => {
      result.current[0](el);
    });
    expect(watchers).toHaveLength(1);
    expect(watchers[0].observed).toEqual([el]);

    report(watchers[0], 1184);
    expect(result.current[1]).toBe(1184);
    report(watchers[0], 1657);
    expect(result.current[1]).toBe(1657);
  });

  /** React 19 calls what a ref callback returns as its cleanup — the observer goes with it. */
  it("gives the observer back when the element goes", () => {
    const { result } = renderHook(() => useElementWidth<HTMLDivElement>());
    const held: { cleanup?: unknown } = {};

    act(() => {
      held.cleanup = result.current[0](document.createElement("div"));
    });
    expect(held.cleanup).toBeTypeOf("function");
    expect(watchers[0].disconnected).toBe(false);
    act(() => {
      if (typeof held.cleanup === "function") held.cleanup();
    });
    expect(watchers[0].disconnected).toBe(true);
  });

  it("hands back the same ref on every render, so React never re-attaches it", () => {
    const { result, rerender } = renderHook(() => useElementWidth<HTMLDivElement>());
    const first = result.current[0];

    rerender();
    expect(result.current[0]).toBe(first);
  });
});
