import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_PANEL_WIDTH_PX } from "@/features/search/CardSearchPanel";
import { useDeskWidth } from "./useDeskWidth";

/**
 * **jsdom lays nothing out**, so every `clientWidth` in this environment answers `0` — the desk's
 * and `documentElement`'s alike. That is not a gap to work around: it is exactly the unmeasured
 * state the hook is written to read as *roomy*, and it is why the shipped window is where the
 * pixel is settled and this file settles the wiring.
 *
 * So what is asserted here is the **wiring and the arithmetic**: which box is observed, that the
 * observer is given back on unmount, that an unmeasured row rails nothing, and that the two caps
 * are the ones the hook claims. Every number a test does assert is stubbed by hand and labelled
 * where it is stubbed — it is the hook's own arithmetic being pinned, never a claim about what a
 * browser would have measured.
 */

/** A desk row of a given width. jsdom's `clientWidth` is a prototype getter answering `0`, so an
 *  own property on the instance is the one way to give a box a width without a layout engine. */
function deskBox(width: number): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
  return el;
}

/** The window's *layout* width — the number the hook is required to read, and the one jsdom
 *  answers `0` to until a test says otherwise. */
function layoutWidth(px: number): void {
  Object.defineProperty(document.documentElement, "clientWidth", { value: px, configurable: true });
}

/**
 * Every `ResizeObserver` the hook constructs, with what it was told to watch.
 *
 * `test-setup.ts` installs a no-op class globally — enough for a wall that only has to not throw,
 * and useless here, where *which box is observed* and *whether it is given back* are half of what
 * is under test.
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
      // Held per instance rather than looked up as "the last one made": two of these are alive at
      // once in the floor test below, and an instance that wrote to whichever was newest would
      // record the wrong box and hide a real miss.
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

afterEach(() => {
  vi.unstubAllGlobals();
  // Both of these are own properties this file defined over jsdom's prototype getters; dropping
  // them puts the environment back to answering `0`, which is what every other suite assumes.
  delete (document.documentElement as unknown as { clientWidth?: number }).clientWidth;
});

/** Render the hook against a desk of a given width. The ref is a plain object because that is all
 *  a `RefObject` is, and because the element has to be in place before the effect runs. */
function mount(desk: HTMLElement | null, floor = 192) {
  const ref = { current: desk };
  return renderHook(() => useDeskWidth(ref, floor));
}

/** Tell the last observer its box changed size. The hook reads the width off the element rather
 *  than off the entry, so the entries list is deliberately empty. */
function resize(): void {
  const watcher = watchers[watchers.length - 1];
  act(() => watcher.callback([], {} as ResizeObserver));
}

describe("useDeskWidth", () => {
  it("reads an unmeasured row as roomy and caps nothing", () => {
    // No stubbing at all: this is jsdom exactly as every page test meets it, and the first paint
    // before the observer has answered.
    const { result } = mount(deskBox(0));

    expect(result.current.maxPanelWidth).toBe(Number.POSITIVE_INFINITY);
    expect(result.current.roomy).toBe(true);
    expect(result.current.overWidth).toBeUndefined();
  });

  it("takes the viewport from documentElement.clientWidth and never from window.innerWidth", () => {
    // The measured pair, from the deck editor at a 1280px window: the layout is 15px narrower than
    // `innerWidth` because `innerWidth` counts the classic scrollbar and the layout does not.
    layoutWidth(1265);
    vi.stubGlobal("innerWidth", 1280);
    expect(window.innerWidth).toBe(1280); // the premise; a stub that did not take voids the test

    // Wide enough that the floor cap cannot bind, so the half-window cap is the only answer.
    const { result } = mount(deskBox(2000));

    expect(result.current.maxPanelWidth).toBe(632);
    expect(result.current.maxPanelWidth).not.toBe(640);
  });

  it("caps on what the row can spare over the list's floor when that is the smaller half", () => {
    layoutWidth(2560); // half is 1280 — far more than this row has
    const { result } = mount(deskBox(800), 192);

    expect(result.current.maxPanelWidth).toBe(800 - 16 - 192); // less the row's `gap-4`
    expect(result.current.roomy).toBe(true);
    expect(result.current.overWidth).toBeUndefined();
  });

  it("takes the floor from its caller rather than assuming one number", () => {
    // The same row twice. A grid's floor leaves room for the column; a table's min-content floor
    // near 520 does not — which is the whole reason the floor is an argument.
    layoutWidth(2560);
    const grid = mount(deskBox(800), 192);
    expect(grid.result.current.maxPanelWidth).toBe(592);
    expect(grid.result.current.roomy).toBe(true);

    const table = mount(deskBox(800), 620);
    expect(table.result.current.maxPanelWidth).toBe(164);
    expect(table.result.current.roomy).toBe(false);
    expect(table.result.current.overWidth).toBe(800);
  });

  it("draws the panel over the list on a row too narrow to hold both", () => {
    layoutWidth(390); // a phone
    const { result } = mount(deskBox(380));

    // 380 less the gap and the floor is 172, under one card's worth of panel.
    expect(result.current.maxPanelWidth).toBeLessThan(MIN_PANEL_WIDTH_PX);
    expect(result.current.roomy).toBe(false);
    expect(result.current.overWidth).toBe(380);
  });

  it("answers again when the row is resized", () => {
    layoutWidth(2560);
    const desk = deskBox(800);
    const { result } = mount(desk, 192);
    expect(result.current.maxPanelWidth).toBe(592);

    // The drag handle on the app's sidebar, the window narrowing — anything that changes the row.
    Object.defineProperty(desk, "clientWidth", { value: 400, configurable: true });
    layoutWidth(1265);
    resize();

    expect(result.current.maxPanelWidth).toBe(400 - 16 - 192);
    expect(result.current.roomy).toBe(false);
    expect(result.current.overWidth).toBe(400);
  });

  it("observes the desk row and disconnects the observer on unmount", () => {
    const desk = deskBox(800);
    const { unmount } = mount(desk);

    expect(watchers).toHaveLength(1);
    expect(watchers[0].observed).toEqual([desk]);
    expect(watchers[0].disconnected).toBe(false);

    unmount();

    expect(watchers[0].disconnected).toBe(true);
  });

  it("observes nothing at all when the row is not mounted", () => {
    // A `null` ref is the state before a commit, and the hook must not construct an observer it
    // can never disconnect.
    const { result } = mount(null);

    expect(watchers).toHaveLength(0);
    expect(result.current.roomy).toBe(true);
    expect(result.current.maxPanelWidth).toBe(Number.POSITIVE_INFINITY);
  });
});
