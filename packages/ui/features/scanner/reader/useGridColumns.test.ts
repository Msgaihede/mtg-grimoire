import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gridTrackCount, useGridColumns } from "./useGridColumns";

describe("gridTrackCount", () => {
  it("counts the lengths a browser resolves a template to", () => {
    expect(gridTrackCount("149px 149px 149px 149px")).toBe(4);
    expect(gridTrackCount("180.5px 180.5px")).toBe(2);
  });

  it("does not count line names as tracks", () => {
    expect(gridTrackCount("[full-start] 150px [mid a] 150px [full-end]")).toBe(2);
  });

  it("answers 0 for a template nobody resolved, and for none", () => {
    // jsdom echoes the declared value back.
    expect(gridTrackCount("repeat(auto-fill, minmax(min(9rem, calc(50% - 0.375rem)), 1fr))")).toBe(
      0,
    );
    expect(gridTrackCount("none")).toBe(0);
    expect(gridTrackCount("")).toBe(0);
  });
});

/**
 * **jsdom lays nothing out and its observer never reports**, so what is pinned here is the wiring:
 * `0` until the observer says something, the count read off the observed probe's computed template
 * each time it does, and the observer given back — and `0` again — when the element goes. The
 * templates are stubbed by hand.
 */
describe("useGridColumns", () => {
  let callbacks: ResizeObserverCallback[] = [];
  let disconnected = 0;
  /** What the grid's computed template resolves to — jsdom resolves none, so the test says it. */
  let template = "";

  beforeEach(() => {
    callbacks = [];
    disconnected = 0;
    template = "";
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      () => ({ gridTemplateColumns: template }) as CSSStyleDeclaration,
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          callbacks.push(callback);
        }
        observe() {}
        unobserve() {}
        disconnect() {
          disconnected += 1;
        }
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function fire(): void {
    act(() => {
      for (const callback of callbacks) callback([], {} as ResizeObserver);
    });
  }

  it("answers 0 until the observer reports, then the grid's resolved column count", () => {
    const { result } = renderHook(() => useGridColumns<HTMLUListElement>());
    expect(result.current[1]).toBe(0);

    template = "150px 150px 150px";
    act(() => {
      result.current[0](document.createElement("ul"));
    });
    expect(result.current[1]).toBe(0);

    fire();
    expect(result.current[1]).toBe(3);

    template = "150px 150px";
    fire();
    expect(result.current[1]).toBe(2);
  });

  /**
   * **Back to unmeasured when the probe goes**, so a grid drawn again later — the layout toggled
   * away and back — does not span from the count of a width it no longer has.
   */
  it("gives the observer back when the element goes, and answers 0 again", () => {
    const { result } = renderHook(() => useGridColumns<HTMLUListElement>());
    template = "150px 150px 150px";
    let cleanup: void | (() => void) = undefined;
    act(() => {
      cleanup = result.current[0](document.createElement("ul"));
    });
    fire();
    expect(result.current[1]).toBe(3);
    expect(typeof cleanup).toBe("function");
    act(() => {
      (cleanup as unknown as () => void)();
    });
    expect(disconnected).toBe(1);
    expect(result.current[1]).toBe(0);
  });
});
