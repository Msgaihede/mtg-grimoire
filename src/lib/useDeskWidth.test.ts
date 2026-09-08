import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_PANEL_WIDTH_PX } from "@/features/search/CardSearchPanel";
import { useDeskWidth, type DeskOptions } from "./useDeskWidth";

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
 *  a `RefObject` is, and because the element has to be in place before the effect runs.
 *
 *  **Two arguments, literally** — no third, not even an `undefined`. That is what makes every case
 *  in this file outside the options block below a regression fence for `CollectionPage` and
 *  `WishlistPage`, which call it exactly this way. */
function mount(desk: HTMLElement | null, floor = 192) {
  const ref = { current: desk };
  return renderHook(() => useDeskWidth(ref, floor));
}

/** The same row, measured by a caller that has an opinion about the gap or the floor. A separate
 *  helper rather than a third parameter on {@link mount}, so nothing can accidentally hand the
 *  hook a third argument in a case that is meant to prove the two-argument shape. */
function mountWith(desk: HTMLElement | null, floor: number, options: DeskOptions) {
  const ref = { current: desk };
  return renderHook(() => useDeskWidth(ref, floor, options));
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

  /**
   * The two numbers a caller may name — the row's own `gap` and the narrowest its docked column
   * may be drawn — added 2026-09-08 for a **third** desk that is neither of the two this hook was
   * extracted from: the decks page's folder tree, whose row is `gap-5` and whose column is a tree
   * rather than a wall of card tiles.
   *
   * **The assertion that matters most is the first one**, and it is about the callers that pass
   * nothing: an options bag whose defaults were a pixel off would move the collection's and the
   * wishlist's panels on every window, silently, with every existing case here still green
   * because they would all be measuring the new number. So the defaults are pinned as *numbers*
   * (16, and `MIN_PANEL_WIDTH_PX`) rather than as "whatever the hook does".
   */
  describe("the caller's gap and floor", () => {
    it("reproduces today's numbers exactly when neither is named", () => {
      layoutWidth(2560); // half is 1280, far more than this row has — the floor cap is the answer
      const desk = deskBox(800);

      const bare = mount(desk, 192);
      const spelled = mountWith(desk, 192, { gap: 16, min: MIN_PANEL_WIDTH_PX });

      // Whole objects, so a fourth number added to `DeskWidth` later is covered by this too.
      expect(bare.result.current).toEqual(spelled.result.current);
      // And the numbers themselves, so a *pair* of matching wrong answers cannot pass: `gap-4`
      // is 16 and the panel's floor is 206, both spelled here rather than read off the hook.
      expect(bare.result.current.maxPanelWidth).toBe(800 - 16 - 192);
      expect(bare.result.current.roomy).toBe(true);
      expect(bare.result.current.overWidth).toBeUndefined();
    });

    it("subtracts the gap the caller names rather than `gap-4`", () => {
      layoutWidth(2560);

      // The decks desk is `gap-5` — 20px, four more than the two rows this was extracted from.
      const { result } = mountWith(deskBox(800), 192, { gap: 20 });

      expect(result.current.maxPanelWidth).toBe(800 - 20 - 192);
      // Named against the default rather than only as an arithmetic result: 592 is what a hook
      // that ignored the option would answer, and it is four pixels away.
      expect(result.current.maxPanelWidth).not.toBe(592);
    });

    /**
     * The floor is what `roomy` is decided against, and the two answers here are opposite for one
     * row — which is the whole reason it is a parameter. A folder tree can be drawn narrower than
     * a card search panel can, so the same 380px desk rails one and not the other.
     */
    it("decides roominess against the floor the caller names", () => {
      layoutWidth(2560);
      const desk = deskBox(380); // 380 less `gap-4` and a 192 list floor leaves 172

      const panel = mount(desk, 192);
      expect(panel.result.current.maxPanelWidth).toBe(172);
      expect(172).toBeLessThan(MIN_PANEL_WIDTH_PX); // the premise, spelled out
      expect(panel.result.current.roomy).toBe(false);
      expect(panel.result.current.overWidth).toBe(380);

      const tree = mountWith(desk, 192, { min: 160 });
      expect(tree.result.current.maxPanelWidth).toBe(172);
      expect(tree.result.current.roomy).toBe(true);
      expect(tree.result.current.overWidth).toBeUndefined();
    });

    /**
     * Each half defaults on its own. A bag that filled both from one branch would make naming the
     * gap silently move the floor — the kind of coupling nothing on screen would explain.
     */
    it("takes either one without the other", () => {
      layoutWidth(2560);

      const gapOnly = mountWith(deskBox(800), 192, { gap: 20 });
      expect(gapOnly.result.current.maxPanelWidth).toBe(588);
      // Still measured against `MIN_PANEL_WIDTH_PX`, which 588 clears.
      expect(gapOnly.result.current.roomy).toBe(true);

      const minOnly = mountWith(deskBox(800), 192, { min: 700 });
      // Still `gap-4`, so 592 rather than 588.
      expect(minOnly.result.current.maxPanelWidth).toBe(592);
      expect(minOnly.result.current.roomy).toBe(false);
      expect(minOnly.result.current.overWidth).toBe(800);
    });

    /**
     * **`min` decides `roomy` and never clamps `maxPanelWidth`.** A row that can spare less than
     * the column's floor has to be able to *say* so — clamping the cap up to the floor would make
     * every desk look roomy and the rail unreachable.
     */
    it("lets the cap answer below the floor rather than clamping to it", () => {
      layoutWidth(2560);

      const { result } = mountWith(deskBox(380), 192, { min: 300 });

      expect(result.current.maxPanelWidth).toBe(172);
      expect(result.current.roomy).toBe(false);
    });

    /**
     * An unmeasured row is roomy whatever it is asked for — jsdom, and the first paint before the
     * observer has answered. A floor read as binding here would rail every desk for one commit on
     * every load, which is what the `deskWidth === 0` arm exists to prevent; naming the option
     * must not reach around it.
     */
    it("still reads an unmeasured row as roomy", () => {
      const { result } = mountWith(deskBox(0), 192, { gap: 20, min: 4_000 });

      expect(result.current.maxPanelWidth).toBe(Number.POSITIVE_INFINITY);
      expect(result.current.roomy).toBe(true);
      expect(result.current.overWidth).toBeUndefined();
    });
  });
});
