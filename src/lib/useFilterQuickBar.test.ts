import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOCKED_BAR_CLEARANCE_PX, DOCKED_BAR_HEIGHT_PX } from "./dockedBar";
import { useFilterQuickBar } from "./useFilterQuickBar";

/**
 * **jsdom computes no intersections**, and `src/test-setup.ts` installs an observer that never
 * fires — which is what keeps the quick bar down in every other suite. So this file installs its
 * own, `useUndocked.test.ts`'s driven stub read verbatim: it records what each observer was built
 * with and pointed at, and a test hands it an entry itself. The entries are the three fields
 * `useUndocked` reads and nothing more; the numbers in them are viewport pixels a browser would
 * have measured, stubbed and labelled as such.
 */

interface Watcher {
  callback: IntersectionObserverCallback;
  options: IntersectionObserverInit | undefined;
  observed: Element[];
  disconnected: boolean;
  instance: IntersectionObserver;
}
let watchers: Watcher[] = [];

beforeEach(() => {
  watchers = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private readonly record: Watcher;
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        this.record = {
          callback,
          options,
          observed: [],
          disconnected: false,
          instance: this as unknown as IntersectionObserver,
        };
        watchers.push(this.record);
      }
      observe(target: Element) {
        this.record.observed.push(target);
      }
      unobserve() {}
      disconnect() {
        this.record.disconnected = true;
      }
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/**
 * One notification about `target`, delivered to every live observer watching it: whether it
 * intersects the scroller, where its bottom edge is, and where the scroller's top edge is.
 *
 * **Watched by nothing, it is delivered to nothing** — which is the disabled case's whole claim:
 * a hook handed no row builds no observer, so a crossing the browser would have reported has
 * nobody to report it to. Not wrapped in `act` itself; each call site does that, since the
 * callback is a state update arriving from outside React's own events.
 */
function fireCrossing(
  target: Element,
  { isIntersecting, bottom, rootTop }: { isIntersecting: boolean; bottom: number; rootTop: number },
): void {
  const entry = {
    isIntersecting,
    boundingClientRect: { bottom } as DOMRectReadOnly,
    rootBounds: { top: rootTop } as DOMRectReadOnly,
  } as IntersectionObserverEntry;
  for (const w of watchers) {
    if (!w.disconnected && w.observed.includes(target)) w.callback([entry], w.instance);
  }
}

/**
 * `AppShell`'s `main` in miniature: a scroller with the shell's 20px top padding, and the page's
 * filter row inside it. jsdom cascades inline styles, so an inline `overflow-y` is the one way to
 * make `nearestScroller` stop at a box, and an inline `padding-top` is what `getComputedStyle`
 * reads back for the scroll padding's arithmetic.
 */
function page() {
  const main = document.createElement("main");
  main.style.overflowY = "auto";
  main.style.paddingTop = "20px";
  const row = document.createElement("div");
  main.appendChild(row);
  document.body.appendChild(main);
  return { main, row };
}

describe("useFilterQuickBar", () => {
  it("is hidden, with no clearance, until the row has scrolled above the scroller", () => {
    const { row } = page();
    const { result } = renderHook(() => useFilterQuickBar(row, true));
    expect(result.current).toEqual({ shown: false, dockTop: 0, stickyTop: 0 });
  });

  it("shows once the row is above the top, with the deck bar's clearances", () => {
    const { main, row } = page();
    const { result } = renderHook(() => useFilterQuickBar(row, true));
    act(() => fireCrossing(row, { isIntersecting: false, bottom: -5, rootTop: 0 }));
    expect(result.current).toEqual({
      shown: true,
      dockTop: DOCKED_BAR_CLEARANCE_PX,
      stickyTop: DOCKED_BAR_HEIGHT_PX,
    });
    // The scroller's own 20px padding plus the clearance (WCAG 2.4.11).
    expect(main.style.scrollPaddingTop).toBe(`${20 + DOCKED_BAR_CLEARANCE_PX}px`);
  });

  it("never shows while disabled (table view), whatever the row does", () => {
    const { main, row } = page();
    const { result } = renderHook(() => useFilterQuickBar(row, false));
    act(() => fireCrossing(row, { isIntersecting: false, bottom: -5, rootTop: 0 }));
    expect(result.current.shown).toBe(false);
    expect(main.style.scrollPaddingTop).toBe("");
  });

  it("takes the scroll padding off again when the bar goes", () => {
    const { main, row } = page();
    renderHook(() => useFilterQuickBar(row, true));
    act(() => fireCrossing(row, { isIntersecting: false, bottom: -5, rootTop: 0 }));
    act(() => fireCrossing(row, { isIntersecting: true, bottom: 40, rootTop: 0 }));
    expect(main.style.scrollPaddingTop).toBe("");
  });
});
