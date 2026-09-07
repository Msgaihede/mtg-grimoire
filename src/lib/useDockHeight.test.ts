import { renderHook } from "@testing-library/react";
import { useRef, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDockHeight } from "./useDockHeight";

/**
 * **jsdom lays nothing out**, so every number this hook reads answers `0` and every `overflow-y`
 * it walks past answers `""`. That is not a gap to work around — it is the reason the hook leaves
 * a zero height *unset*, and the reason the shipped window is where the pixel is settled.
 *
 * What this file asserts is therefore the **wiring**: which box is found, what is listened to,
 * that a burst of scrolls costs one frame, and that the whole of it is given back on unmount. The
 * two cases that do assert a number stub the three measurements by hand and are labelled where
 * they do it — the arithmetic is the hook's own and worth pinning, and it is not a claim about
 * what a browser would have measured.
 */

/** A box a `getComputedStyle` walk will stop at. jsdom cascades inline styles, so this is the one
 *  way to make an element a scroller in an environment with no stylesheet. */
function scrollerBox(visible: number): HTMLElement {
  const el = document.createElement("div");
  el.style.overflowY = "auto";
  Object.defineProperty(el, "clientHeight", { value: visible, configurable: true });
  return el;
}

/** Where a box's top edge sits, for the one subtraction this hook does. */
function topAt(el: HTMLElement, top: number): void {
  el.getBoundingClientRect = () => ({ top }) as DOMRect;
}

/**
 * Every `ResizeObserver` this test file's hook constructs, with what each was told to watch.
 *
 * `test-setup.ts` installs a no-op class globally — enough for a wall that only has to not throw,
 * and useless here, where *which boxes are observed* is half of what is under test.
 */
interface Watcher {
  callback: ResizeObserverCallback;
  observed: Element[];
  disconnected: boolean;
}
let watchers: Watcher[] = [];

/** The frames `requestAnimationFrame` was asked for, so a test can run them by hand and count
 *  them — the coalescing claim is a claim about that count. */
let frames: FrameRequestCallback[] = [];
let cancelled: number[] = [];

beforeEach(() => {
  watchers = [];
  frames = [];
  cancelled = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        watchers.push({ callback, observed: [], disconnected: false });
      }
      private get self(): Watcher {
        return watchers[watchers.length - 1];
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
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => cancelled.push(id));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

/** Run whatever frames are pending, the way a browser would on the next tick. */
function runFrames(): void {
  const pending = frames;
  frames = [];
  for (const cb of pending) cb(0);
}

/**
 * Mount the hook over two boxes already in a tree.
 *
 * The refs are seeded on the first render rather than attached by React, which is the honest
 * stand-in for a call site whose JSX carries `ref={dockRef}`: by the time a layout effect runs,
 * the ref holds the element either way.
 */
function mount(dock: HTMLElement | null, anchor: HTMLElement | null) {
  return renderHook(
    ({ d, a }: { d: HTMLElement | null; a: HTMLElement | null }) => {
      const dockRef = useRef<HTMLElement | null>(d);
      const anchorRef = useRef<HTMLElement | null>(a);
      dockRef.current = d;
      anchorRef.current = a;
      useDockHeight(
        dockRef as RefObject<HTMLElement | null>,
        anchorRef as RefObject<HTMLElement | null>,
      );
    },
    { initialProps: { d: dock, a: anchor } },
  );
}

/** A scroller with a row inside it and a dock beside the row, all three connected — the shape
 *  every call site draws. */
function tree(visible: number) {
  const scroller = scrollerBox(visible);
  const row = document.createElement("div");
  const dock = document.createElement("div");
  row.append(dock);
  scroller.append(row);
  document.body.append(scroller);
  return { scroller, row, dock };
}

describe("useDockHeight", () => {
  it("draws the dock as the scrollport left under the row", () => {
    // The three measurements a browser would have made, stubbed: a 600px scrollport whose top is
    // the window's, and a row starting 140px down it. 460 is what is left below the row's top.
    const { scroller, row, dock } = tree(600);
    topAt(scroller, 0);
    topAt(row, 140);

    mount(dock, row);

    expect(dock.style.height).toBe("460px");
  });

  /** Scrolled past its own start, the row's top is above the scrollport's and the dock is the
   *  whole of it — never more, which a bare subtraction would have made it. */
  it("gives the dock the whole scrollport once the row has scrolled past", () => {
    const { scroller, row, dock } = tree(600);
    topAt(scroller, 0);
    topAt(row, -900);

    mount(dock, row);

    expect(dock.style.height).toBe("600px");
  });

  /** And never a negative one: a row below the fold is a dock of nothing, not of `-200px`. */
  it("floors at nothing when the row starts below the scrollport", () => {
    const { scroller, row, dock } = tree(600);
    topAt(scroller, 0);
    topAt(row, 800);

    mount(dock, row);

    expect(dock.style.height).toBe("0px");
  });

  /**
   * **A zero scrollport is left unset rather than written**, which is the one branch that exists
   * purely for the environment reading it: jsdom answers `0` to `clientHeight` for every element,
   * so a hook that wrote what it measured would collapse the dock in the one place nobody can see
   * it — and would then have to be worked around in every test of every page that draws one.
   */
  it("writes no height where the scroller has not been laid out", () => {
    const { dock, row } = tree(0);

    mount(dock, row);

    expect(dock.style.height).toBe("");
  });

  /** Nothing between the dock and the root scrolls, so there is no scrollport to be a fraction
   *  of and nothing to listen to. A page that grows one later mounts a new dock with it. */
  it("does nothing where no ancestor scrolls", () => {
    const row = document.createElement("div");
    const dock = document.createElement("div");
    row.append(dock);
    document.body.append(row);

    mount(dock, row);

    expect(dock.style.height).toBe("");
    expect(watchers).toHaveLength(0);
  });

  /**
   * The listener goes on the **scroller**, not on the dock and not on `window` — the dock is
   * `sticky` inside it and hears nothing, and `window` would answer for a page this hook is not
   * sizing. `passive`, because nothing here calls `preventDefault` and a non-passive scroll
   * listener blocks the gesture it is only watching.
   */
  it("listens to the scroller passively", () => {
    const { scroller, row, dock } = tree(600);
    const listen = vi.spyOn(scroller, "addEventListener");

    mount(dock, row);

    expect(listen).toHaveBeenCalledWith("scroll", expect.any(Function), { passive: true });
  });

  /** Both boxes, because they move independently: the scrollport is the window's and the row's
   *  top is whatever is above it on the page. */
  it("watches the scroller and the row for a resize", () => {
    const { scroller, row, dock } = tree(600);

    mount(dock, row);

    expect(watchers).toHaveLength(1);
    expect(watchers[0].observed).toEqual([scroller, row]);
  });

  /**
   * **One frame for a burst**, which is the whole reason the rAF is there: a wheel fires far more
   * often than a frame and the work is two `getBoundingClientRect`s. Counted rather than merely
   * observed — a hook that scheduled per event would still produce the right height and would do
   * it thirty times.
   */
  it("coalesces a burst of scrolls into one frame", () => {
    const { scroller, row, dock } = tree(600);
    topAt(scroller, 0);
    topAt(row, 140);
    mount(dock, row);
    frames = [];

    scroller.dispatchEvent(new Event("scroll"));
    scroller.dispatchEvent(new Event("scroll"));
    scroller.dispatchEvent(new Event("scroll"));

    expect(frames).toHaveLength(1);

    // And the frame it did ask for is the one that writes: the row has moved up the scrollport,
    // and the dock follows only once that frame runs.
    topAt(row, 40);
    runFrames();
    expect(dock.style.height).toBe("560px");

    // The gate re-arms, so the next burst is a frame of its own rather than nothing.
    scroller.dispatchEvent(new Event("scroll"));
    expect(frames).toHaveLength(1);
  });

  it("re-measures when either box is resized", () => {
    const { scroller, row, dock } = tree(600);
    topAt(scroller, 0);
    topAt(row, 140);
    mount(dock, row);
    frames = [];

    Object.defineProperty(scroller, "clientHeight", { value: 400, configurable: true });
    watchers[0].callback([], watchers[0] as unknown as ResizeObserver);
    runFrames();

    expect(dock.style.height).toBe("260px");
  });

  /**
   * **The row arrives late, and that is the case a `[]` dependency array silently loses.**
   *
   * Every call site draws its dock conditionally — the deck editor renders its desk only once
   * `deck_get` has answered — so the first commit runs this hook against two `null`s. A `RefObject`
   * notifies nobody, so an effect that looked once would never look again and the dock would go
   * unsized for the life of the page, with nothing on screen to say why.
   */
  it("wires itself when the boxes arrive after the first render", () => {
    const { scroller, row, dock } = tree(600);
    topAt(scroller, 0);
    topAt(row, 140);

    const view = mount(null, null);
    expect(watchers).toHaveLength(0);

    view.rerender({ d: dock, a: row });

    expect(dock.style.height).toBe("460px");
    expect(watchers).toHaveLength(1);
  });

  /**
   * …and a render that changed neither box re-wires nothing. The guard is what lets the layout
   * effect run after *every* commit without paying for it: the call sites re-render on every
   * keystroke in the search box beside them.
   */
  it("leaves its wiring alone across a render that moved neither box", () => {
    const { row, dock } = tree(600);
    const view = mount(dock, row);

    view.rerender({ d: dock, a: row });
    view.rerender({ d: dock, a: row });

    expect(watchers).toHaveLength(1);
    expect(watchers[0].disconnected).toBe(false);
  });

  it("gives up the old wiring when the dock is replaced", () => {
    const { row, dock } = tree(600);
    const view = mount(dock, row);

    const second = document.createElement("div");
    row.append(second);
    view.rerender({ d: second, a: row });

    expect(watchers).toHaveLength(2);
    expect(watchers[0].disconnected).toBe(true);
    expect(watchers[1].disconnected).toBe(false);
  });

  /**
   * Unmount gives back the listener, the observer and any frame still owed. The frame matters as
   * much as the other two: it closes over the dock, and a callback that ran after the tree had
   * gone would write a style onto a detached node — harmless here, and the shape of the leak this
   * hook would otherwise have on every page change.
   */
  it("gives up the listener, the observer and the pending frame when it unmounts", () => {
    const { scroller, row, dock } = tree(600);
    const stop = vi.spyOn(scroller, "removeEventListener");
    const view = mount(dock, row);
    scroller.dispatchEvent(new Event("scroll"));
    const owed = frames.length;

    view.unmount();

    expect(stop).toHaveBeenCalledWith("scroll", expect.any(Function));
    expect(watchers[0].disconnected).toBe(true);
    expect(cancelled).toHaveLength(owed);
    // And the listener really is gone: a scroll after the unmount asks for no frame.
    frames = [];
    scroller.dispatchEvent(new Event("scroll"));
    expect(frames).toHaveLength(0);
  });
});
