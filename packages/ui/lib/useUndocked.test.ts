import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUndocked } from "./useUndocked";

/**
 * **jsdom computes no intersections**, and `packages/ui/test-setup.ts` installs an observer that never
 * fires — which is what keeps the deck editor's bar unmounted in every other suite. So this file
 * installs its own: it records what each observer was built with and pointed at, and a test hands
 * it an entry itself. The entries are the three fields the hook reads and nothing more; the
 * numbers in them are viewport pixels a browser would have measured, stubbed and labelled as such.
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
 * Where the scroller's top edge sits in the viewport: under the 34px title bar and the 56px
 * ribbon, which is where `AppShell`'s `main` starts in the desktop window. Any positive number
 * would do; a real one keeps the arithmetic below readable as a page.
 */
const ROOT_TOP = 90;

/**
 * A header line inside a page inside a scroller, all connected. The page box between them
 * scrolls nothing, so the walk has to pass it — the shape the deck editor draws, several levels
 * down `main`. jsdom cascades inline styles, so an inline `overflow-y` is the one way to make a
 * scroller in an environment with no stylesheet.
 */
function tree() {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  const page = document.createElement("div");
  const line = document.createElement("div");
  page.append(line);
  scroller.append(page);
  document.body.append(scroller);
  return { scroller, line };
}

function mount(el: HTMLElement | null) {
  return renderHook(({ target }: { target: HTMLElement | null }) => useUndocked(target), {
    initialProps: { target: el },
  });
}

/** One notification: whether the line intersects the scroller, and where its bottom edge is. */
function report(watcher: Watcher, isIntersecting: boolean, bottom: number): void {
  const entry = {
    isIntersecting,
    boundingClientRect: { bottom } as DOMRectReadOnly,
    rootBounds: { top: ROOT_TOP } as DOMRectReadOnly,
  } as IntersectionObserverEntry;
  // `act`, because the callback is a state update arriving from outside React's own events.
  act(() => watcher.callback([entry], watcher.instance));
}

describe("useUndocked", () => {
  /** An observer answers on its own schedule, so the first render has heard nothing — and
   *  nothing heard is docked, which is the header drawn where it is. */
  it("starts docked, watching the element", () => {
    const { line } = tree();

    const { result } = mount(line);

    expect(result.current).toBe(false);
    expect(watchers).toHaveLength(1);
    expect(watchers[0].observed).toEqual([line]);
  });

  /** The page scroller, not the viewport — `main` sits 90px down the window, and a line
   *  scrolled under the ribbon is out of the page while still inside the window. `threshold: 0`,
   *  because the question is the crossing of an edge and not how much of the line is showing. */
  it("roots the observer on the nearest scroller, at threshold 0", () => {
    const { scroller, line } = tree();

    mount(line);

    expect(watchers[0].options?.root).toBe(scroller);
    expect(watchers[0].options?.threshold).toBe(0);
  });

  it("undocks once the line has scrolled up past the scroller's top edge", () => {
    const { line } = tree();
    const { result } = mount(line);

    report(watchers[0], false, ROOT_TOP - 30);

    expect(result.current).toBe(true);
  });

  it("docks again when the line comes back into view", () => {
    const { line } = tree();
    const { result } = mount(line);
    report(watchers[0], false, ROOT_TOP - 30);

    report(watchers[0], true, ROOT_TOP + 20);

    expect(result.current).toBe(false);
  });

  /**
   * **Out of view is not scrolled past.** A line below the scrollport intersects nothing either,
   * and reading that as undocked would draw the bar over a page whose header has not been reached.
   */
  it("stays docked for a line that is out of view below the scroller", () => {
    const { line } = tree();
    const { result } = mount(line);

    report(watchers[0], false, ROOT_TOP + 1400);

    expect(result.current).toBe(false);
  });

  it("answers docked and builds nothing for no element", () => {
    const { result } = mount(null);

    expect(result.current).toBe(false);
    expect(watchers).toHaveLength(0);
  });

  /** Nothing between the line and the root scrolls, so there is no edge to cross. */
  it("answers docked and builds nothing where no ancestor scrolls", () => {
    const line = document.createElement("div");
    document.body.append(line);

    const { result } = mount(line);

    expect(result.current).toBe(false);
    expect(watchers).toHaveLength(0);
  });

  it("answers docked where there is no IntersectionObserver at all", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { line } = tree();

    const { result } = mount(line);

    expect(result.current).toBe(false);
  });

  /**
   * **The answer belongs to the element it was measured for.** A new element reads as docked the
   * moment it is handed over — derived, with no reset written — and the old observer is given up
   * for one watching the new element.
   */
  it("reads a new element as docked until its own observer answers", () => {
    const { line } = tree();
    const second = document.createElement("div");
    line.after(second);
    const view = mount(line);
    report(watchers[0], false, ROOT_TOP - 30);
    expect(view.result.current).toBe(true);

    view.rerender({ target: second });

    expect(view.result.current).toBe(false);
    expect(watchers[0].disconnected).toBe(true);
    expect(watchers).toHaveLength(2);
    expect(watchers[1].observed).toEqual([second]);
  });

  /**
   * A notification from an observer that has been torn down describes an observation that has
   * ended. Leaving and coming back is the case where the derived answer alone cannot tell: the
   * element in state is the same one again, so a late entry from the first observer would pass
   * for the second's.
   */
  it("ignores a notification from an observer it has already given up", () => {
    const { line } = tree();
    const view = mount(line);
    view.rerender({ target: null });
    view.rerender({ target: line });

    report(watchers[0], false, ROOT_TOP - 30);

    expect(view.result.current).toBe(false);
  });

  it("gives the observer up when it unmounts", () => {
    const { line } = tree();
    const view = mount(line);

    view.unmount();

    expect(watchers[0].disconnected).toBe(true);
  });
});
